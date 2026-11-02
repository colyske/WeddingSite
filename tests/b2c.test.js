import test from "node:test";
import assert from "node:assert/strict";
import { b2cReadiness, capabilityHash, callbackEvidence, dispatchB2c, receiveB2cCallback, runB2cWorker } from "../server/b2c.js";
const id = "10000000-0000-4000-8000-000000000001";
const env = {
  WEDDINGSITE_PAYMENT_MODE: "live", DARAJA_ENVIRONMENT: "production",
  DARAJA_B2C_ENABLED: "true", DARAJA_B2C_API_VERSION: "v1",
  DARAJA_B2C_CONTRACT_VERIFIED: "true", DARAJA_B2C_CAPABILITY_CONFIRMED: "true",
  DARAJA_B2C_SHORTCODE: "123456", DARAJA_B2C_SHORTCODE_CONFIRMED: "123456",
  DARAJA_B2C_COMMAND_ID: "BusinessPayment", DARAJA_CONSUMER_KEY: "synthetic",
  DARAJA_CONSUMER_SECRET: "synthetic", DARAJA_B2C_INITIATOR_NAME: "synthetic",
  DARAJA_B2C_INITIATOR_PASSWORD: "synthetic", DARAJA_B2C_CERTIFICATE_PEM: "synthetic",
  DARAJA_B2C_CERTIFICATE_SHA256: "a".repeat(64), WEDDINGSITE_PUBLIC_ORIGIN: "https://example.test"
};
const never = () => { throw new Error("Unintended call"); };
const snapshot = { id, claimed: true, payout_id: id, amount_minor: 1200, msisdn: "254700000001",
  shortcode: "123456", command_id: "BusinessPayment" };
const provider = async url => new Response(JSON.stringify(url.includes("oauth") ? { access_token: "synthetic" }
  : { ResponseCode: 0, ConversationID: "CONV", OriginatorConversationID: "ORIGIN" }));

test("default deployment gates deny before reservation/provider work; worker only maintains holds", async () => {
  assert.equal(b2cReadiness({}).ready, false);
  assert.equal(b2cReadiness({}).autoApprovalGate, false);
  await assert.rejects(dispatchB2c(id, id, { env: {}, rpc: never, fetcher: never }), /prerequisites/);
  const calls = [];
  assert.deepEqual(await runB2cWorker({ env: {}, rpc: async name => { calls.push(name); }, fetcher: never }),
    { held: true, reason: "deployment_prerequisites" });
  assert.deepEqual(calls, ["b2c_mark_stale"]);
});
test("durable common claim precedes all provider calls and repeated claim cannot resend", async () => {
  const calls = [];
  let claims = 0;
  const rpc = async (name, body) => {
    calls.push(name);
    if (name === "b2c_claim") {
      assert.equal(body.p_auto, false);
      assert.match(body.p_callback_hash, /^[a-f0-9]{64}$/);
      return ++claims === 1 ? snapshot : { claimed: false, state: "executing" };
    }
    assert.equal(body.p_kind, "accepted");
    return "executing";
  };
  const options = { env, rpc, encryptCredential: () => "synthetic-encrypted",
    fetcher: async (...args) => { calls.push("provider"); return provider(...args); } };
  const result = await dispatchB2c(id, id, options);
  assert.equal(calls[0], "b2c_claim");
  assert.equal(result.accepted, true);
  assert.equal(result.settled, false);
  const before = calls.filter(v => v === "provider").length;
  assert.equal((await dispatchB2c(id, id, options)).alreadyClaimed, true);
  assert.equal(calls.filter(v => v === "provider").length, before);
});
test("timeout, malformed acceptance and lost acceptance journal all retain uncertain claim without retry", async () => {
  for (const failure of ["transport", "acceptance", "journal"]) {
    let payments = 0;
    const kinds = [];
    const rpc = async (name, body) => {
      if (name === "b2c_claim") return snapshot;
      kinds.push(body.p_kind);
      if (failure === "journal" && body.p_kind === "accepted") throw new Error("Lost DB response");
      return "uncertain";
    };
    const fetcher = async url => {
      if (url.includes("oauth")) return provider(url);
      payments++;
      if (failure === "transport") throw new Error("synthetic transport loss");
      return failure === "acceptance" ? new Response("{}") : provider(url);
    };
    const result = await dispatchB2c(id, id, { env, rpc, fetcher, encryptCredential: () => "synthetic" });
    assert.equal(payments, 1);
    assert.equal(result.state, "uncertain");
    assert.equal(result.reconciliationRequired, true);
    assert.equal(kinds.at(-1), "uncertain");
  }
});
test("worker skips a prerequisite hold but stops after one durable provider attempt", async () => {
  const held = "10000000-0000-4000-8000-000000000002";
  const unvisited = "10000000-0000-4000-8000-000000000003";
  const claims = [];
  let payments = 0;
  const result = await runB2cWorker({
    env, encryptCredential: () => "synthetic",
    rpc: async (name, body) => {
      if (name === "b2c_candidates") return [held, id, unvisited];
      if (name === "b2c_claim") {
        claims.push(body.p_id);
        if (body.p_id === held) throw new Error("B2C: Recipient evidence changed.");
        return snapshot;
      }
      if (name === "b2c_event") return "executing";
    },
    fetcher: async url => {
      if (!url.includes("oauth")) payments++;
      return provider(url);
    }
  });
  assert.deepEqual(claims, [held, id]);
  assert.equal(payments, 1);
  assert.equal(result.results[0].held, true);
  assert.equal(result.results[1].accepted, true);
});
test("forged capabilities fail before audit; bound duplicates share digest and no callback settles", async () => {
  const token = "b".repeat(64), calls = [];
  const body = { Result: { ConversationID: "CONV", OriginatorConversationID: "ORIGIN",
    ResultCode: 0, TransactionID: "SYNRECEIPT", ResultParameters: { ResultParameter: [{ Key: "Unknown", Value: "ignored" }] } } };
  const rpc = async (name, fields) => {
    calls.push({ name, fields });
    if (name === "b2c_callback_context") {
      assert.equal(fields.p_hash, capabilityHash(token));
      return { id, conversation_id: "CONV", originator_id: "ORIGIN" };
    }
    assert.equal(fields.p_kind, "result");
    assert.equal(fields.p_evidence.result_code, "0");
    assert.equal("amount_minor" in fields.p_evidence, false);
    assert.equal("msisdn" in fields.p_evidence, false);
    return "uncertain";
  };
  await assert.rejects(receiveB2cCallback(id, "", "result", body, { rpc: never }), /capability/);
  const first = await receiveB2cCallback(id, token, "result", body, { rpc });
  const second = await receiveB2cCallback(id, token, "result", body, { rpc });
  assert.equal(first.settled, false);
  assert.equal(first.reconciliationRequired, true);
  assert.deepEqual(first, second);
  assert.equal(calls[1].fields.p_key, calls[3].fields.p_key);
  assert.equal(callbackEvidence({ Result: { ResultCode: 0 } }), null);
});
test("callback-before-acceptance and unverified timeout body are audited holds, never guessed settlement", async () => {
  for (const kind of ["result", "timeout"]) {
    let evidence;
    const result = await receiveB2cCallback(id, "b".repeat(64), kind, { Arbitrary: "not an official schema" }, {
      rpc: async (name, body) => {
        if (name === "b2c_callback_context") return { id, conversation_id: null, originator_id: null };
        evidence = body;
        return "uncertain";
      }
      let event;
      await receiveB2cCallback(id, "b".repeat(64), "result", {
        Result: { ConversationID: "EARLY", OriginatorConversationID: "EARLY-ORIGIN", ResultCode: 0, TransactionID: "EARLYRECEIPT" }
      }, { rpc: async (name, body) => {
        if (name === "b2c_callback_context") return { id };
        event = body;
        return "uncertain";
      } });
      assert.equal(event.p_kind, "uncertain");
      assert.equal(event.p_evidence.conversation_id, "EARLY");
      assert.equal(event.p_evidence.transaction_id, "EARLYRECEIPT");
      assert.equal(event.p_evidence.reason, "unbound_or_mismatched_conversation");
    });
    assert.equal(result.settled, false);
    assert.equal(evidence.p_kind, kind === "timeout" ? "timeout" : "uncertain");
    assert.equal(evidence.p_evidence.reason, "unverified_callback_schema");
  }
});
