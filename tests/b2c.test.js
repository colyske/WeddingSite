import test from "node:test";
import assert from "node:assert/strict";
import { b2cReadiness, capabilityHash, dispatchB2c, receiveB2cCallback, resultEvidence, runB2cWorker, encryptInitiatorCredential } from "../server/b2c.js";

const env = {
  WEDDINGSITE_PAYMENT_MODE: "live", DARAJA_ENVIRONMENT: "production", DARAJA_B2C_ENABLED: "true",
  DARAJA_B2C_API_VERSION: "v3", DARAJA_B2C_CONTRACT_VERIFIED: "true", DARAJA_B2C_CAPABILITY_CONFIRMED: "true",
  DARAJA_B2C_SHORTCODE: "123456", DARAJA_B2C_SHORTCODE_CONFIRMED: "123456",
  DARAJA_B2C_COMMAND_ID: "BusinessPayment", DARAJA_CONSUMER_KEY: "synthetic-key",
  DARAJA_CONSUMER_SECRET: "synthetic-secret", DARAJA_B2C_INITIATOR_NAME: "synthetic",
  DARAJA_B2C_INITIATOR_PASSWORD: "synthetic-password", DARAJA_B2C_CERTIFICATE_PEM: "synthetic",
  DARAJA_B2C_CERTIFICATE_SHA256: "a".repeat(64), WEDDINGSITE_PUBLIC_ORIGIN: "https://example.test"
};
const id = "10000000-0000-4000-8000-000000000001";
const dispatch = { id, claimed: true, originator_id: id, amount_minor: 1200, msisdn: "254700000001", shortcode: "123456", command_id: "BusinessPayment" };
const mustNotCall = () => { throw new Error("Unexpected external or database call"); };

test("B2C defaults deny every provider call; each deployment prerequisite is necessary", async () => {
  assert.equal(b2cReadiness({}).ready, false);
  assert.equal(b2cReadiness({}).autoApprovalGate, false);
  await assert.rejects(dispatchB2c(id, id, "token", { env: {}, rpc: mustNotCall, fetcher: mustNotCall }), /prerequisites/);
  for (const key of Object.keys(env)) {
    const missing = { ...env }; delete missing[key];
    assert.equal(b2cReadiness(missing).ready, false, key);
  }
  assert.equal(b2cReadiness({ ...env, DARAJA_ENVIRONMENT: "sandbox" }).ready, false);
  assert.equal(b2cReadiness({ ...env, DARAJA_B2C_API_VERSION: "v1" }).ready, false);
  assert.equal(b2cReadiness({ ...env, DARAJA_B2C_COMMAND_ID: "TransactionStatusQuery" }).ready, false);
  assert.equal(b2cReadiness({ ...env, WEDDINGSITE_PUBLIC_ORIGIN: "http://example.test" }).ready, false);
  assert.throws(() => encryptInitiatorCredential(env));
});

test("scheduler does only stale-reservation housekeeping with default gates or Owner gate closed", async () => {
  assert.equal((await runB2cWorker({ env: {}, rpc: async name => {
    assert.equal(name, "b2c_mark_stale"); return 0;
  }, fetcher: mustNotCall })).held, true);
  assert.equal((await runB2cWorker({ env, rpc: async () => ({ dispatch_enabled: false }), fetcher: mustNotCall })).held, true);
});

test("already reserved payout never calls OAuth or B2C again", async () => {
  let calls = 0;
  const result = await dispatchB2c(id, id, "token", {
    env, encryptCredential: () => "synthetic-encrypted",
    rpc: async name => { assert.equal(name, "b2c_reserve"); calls++; return { dispatch_id: id, claimed: false, state: "uncertain" }; },
    fetcher: mustNotCall
  });
  assert.equal(calls, 1);
  assert.equal(result.dispatched, false);
  assert.equal(result.state, "uncertain");
});

test("reservation precedes transfer; request uses bound v3 originator, whole KES and distinct callback tokens", async () => {
  const calls = [];
  let reserve;
  const result = await dispatchB2c(id, id, "staff", {
    env, encryptCredential: () => "synthetic-encrypted",
    rpc: async (name, body) => {
      calls.push(name);
      if (name === "b2c_reserve") { reserve = body; return { ...dispatch, originator_id: body.p_originator }; }
      assert.equal(body.p_kind, "accepted");
      return "accepted";
    },
    fetcher: async (url, options) => {
      calls.push(url);
      assert.equal(calls[0], "b2c_reserve");
      if (url.includes("/oauth/")) return { ok: true, json: async () => ({ access_token: "synthetic-access" }) };
      const payload = JSON.parse(options.body);
      assert.equal(payload.OriginatorConversationID, reserve.p_originator);
      assert.equal(payload.Amount, 12);
      assert.equal(payload.PartyB, dispatch.msisdn);
      const callback = new URL(payload.ResultURL);
      assert.equal(callback.searchParams.get("dispatch"), id);
      assert.equal(capabilityHash(callback.searchParams.get("token")), reserve.p_callback_hash);
      assert.notEqual(callback.searchParams.get("token"), reserve.p_originator);
      assert.equal(payload.SecurityCredential, "synthetic-encrypted");
      return { ok: true, json: async () => ({ ResponseCode: "0", ConversationID: "conversation-1", OriginatorConversationID: reserve.p_originator }) };
    }
  });
  assert.equal(result.state, "accepted");
  assert.equal(calls.length, 4);
});

test("timeout, HTTP failure and malformed acceptance all keep uncertain reservation with no retry", async () => {
  for (const variant of ["timeout", "http", "correlation"]) {
    let fetchCalls = 0;
    const events = [];
    const result = await dispatchB2c(id, id, "staff", {
      env, encryptCredential: () => "synthetic-encrypted",
      rpc: async (name, body) => {
        if (name === "b2c_reserve") return dispatch;
        events.push(body); return "uncertain";
      },
      fetcher: async () => {
        fetchCalls++;
        if (variant === "timeout") throw new Error("synthetic timeout");
        if (variant === "http") return { ok: false, status: 500 };
        if (fetchCalls === 1) return { ok: true, json: async () => ({ access_token: "synthetic" }) };
        return { ok: true, json: async () => ({ ResponseCode: "0", ConversationID: "wrong", OriginatorConversationID: "wrong" }) };
      }
    });
    assert.equal(result.state, "uncertain");
    assert.equal(events.length, 1);
    assert.equal(events[0].p_kind, "uncertain");
    assert.ok(fetchCalls <= 2);
  }
});

const mappingEnv = { ...env, DARAJA_B2C_RESULT_MAPPING: JSON.stringify({
  amountParameter: "syntheticAmount", recipientParameter: "syntheticPhone", transactionParameter: "syntheticReceipt"
}) };
const result = { ResultCode: 0, ConversationID: "conversation", OriginatorConversationID: id, ResultParameters: {
  ResultParameter: [{ Key: "syntheticAmount", Value: "12.00" }, { Key: "syntheticPhone", Value: dispatch.msisdn }, { Key: "syntheticReceipt", Value: "SYNTHETIC1" }]
} };

test("unverified result mapping, recipient names, unknown amount, failure and duplicate parameters cannot settle", () => {
  assert.equal(resultEvidence(result, dispatch, {}).verified_contract, false);
  assert.equal(resultEvidence(result, dispatch, env).verified_contract, false);
  assert.equal(resultEvidence({ ...result, ResultCode: 1 }, dispatch, mappingEnv).verified_contract, false);
  const mutated = structuredClone(result);
  mutated.ResultParameters.ResultParameter[1].Value = `${dispatch.msisdn} - Test Name`;
  assert.equal(resultEvidence(mutated, dispatch, mappingEnv).verified_contract, false);
  mutated.ResultParameters.ResultParameter[1].Value = "254700000002";
  assert.equal(resultEvidence(mutated, dispatch, mappingEnv).verified_contract, false);
  mutated.ResultParameters.ResultParameter[0].Value = "12.01";
  assert.equal(resultEvidence(mutated, dispatch, mappingEnv).verified_contract, false);
  mutated.ResultParameters.ResultParameter.push(mutated.ResultParameters.ResultParameter[0]);
  assert.equal(resultEvidence(mutated, dispatch, mappingEnv).verified_contract, false);
  assert.equal(resultEvidence(result, dispatch, mappingEnv).outcome, "succeeded");
});

test("callback requires secret capability and both persisted provider identifiers, even when dispatch gates are closed", async () => {
  const token = "b".repeat(64);
  await assert.rejects(receiveB2cCallback(id, "", "result", { Result: result }, { rpc: mustNotCall }), /capability/);
  let events = 0;
  const rpc = async (name, body) => {
    if (name === "b2c_callback_context") { assert.equal(body.p_hash, capabilityHash(token)); return { ...dispatch, conversation_id: "conversation" }; }
    if (body.p_kind === "rejected") return "accepted";
    events++;
    assert.equal(body.p_evidence.verified_contract, false);
    return "uncertain";
  };
  await assert.rejects(receiveB2cCallback(id, token, "result", { Result: { ...result, ConversationID: "wrong" } }, { env: {}, rpc }), /conversation/);
  await assert.rejects(receiveB2cCallback(id, token, "result", { Result: { ...result, OriginatorConversationID: "wrong" } }, { env: {}, rpc }), /conversation/);
  assert.equal(events, 0);
  assert.equal(await receiveB2cCallback(id, token, "timeout", { Result: result }, { env: {}, rpc }), "uncertain");
  assert.equal(events, 1);
});
