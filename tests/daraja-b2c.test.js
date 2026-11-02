import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { encryptInitiatorCredential, paymentRequest, providerReadiness, oauthToken, submitPayment } from "../server/daraja-b2c.js";

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
const snapshot = { id, amount_minor: 1200, msisdn: "254700000001", shortcode: "123456", command_id: "BusinessPayment" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const never = () => { throw new Error("Unintended network call"); };

test("v1 B2C wire request uses official fields, exact whole KES and separate capability URLs", () => {
  const request = paymentRequest(snapshot, "b".repeat(64), "encrypted", env);
  assert.deepEqual(Object.keys(request), ["InitiatorName", "SecurityCredential", "CommandID", "Amount",
    "PartyA", "PartyB", "Remarks", "QueueTimeOutURL", "ResultURL", "Occasion"]);
  assert.equal(request.Amount, 12);
  assert.equal(request.PartyB, snapshot.msisdn);
  assert.equal("OriginatorConversationID" in request, false);
  assert.equal("Occassion" in request, false);
  assert.match(request.ResultURL, /action=result/);
  assert.match(request.QueueTimeOutURL, /action=timeout/);
  for (const change of [{ amount_minor: 1201 }, { amount_minor: Number.MAX_SAFE_INTEGER + 1 },
    { msisdn: "+254700000001" }, { command_id: "Unknown" }, { shortcode: "654321" }]) {
    assert.throws(() => paymentRequest({ ...snapshot, ...change }, "b".repeat(64), "encrypted", env), /snapshot/);
  }
});

test("provider gates default deny; unsupported v3, sandbox and non-HTTPS callbacks cannot send", async () => {
  assert.equal(providerReadiness({}).ready, false);
  assert.equal(providerReadiness(env).ready, true);
  for (const change of [{ DARAJA_B2C_ENABLED: "false" }, { DARAJA_B2C_API_VERSION: "v3" },
    { DARAJA_ENVIRONMENT: "sandbox" }, { WEDDINGSITE_PUBLIC_ORIGIN: "http://example.test" },
    { WEDDINGSITE_PUBLIC_ORIGIN: "https://example.test/" }, { WEDDINGSITE_PUBLIC_ORIGIN: "https://127.0.0.1" }]) {
    await assert.rejects(submitPayment({}, "synthetic", { env: { ...env, ...change }, fetcher: never }), /disabled/);
  }
});

test("OAuth and v1 submission return acceptance identifiers, never settlement", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return calls.length === 1 ? json({ access_token: "synthetic" }) :
      json({ ResponseCode: "0", ConversationID: "CONV-1", OriginatorConversationID: "ORIGIN-1" });
  };
  const token = await oauthToken({ env, fetcher });
  const result = await submitPayment(paymentRequest(snapshot, "b".repeat(64), "encrypted", env), token, { env, fetcher });
  assert.deepEqual(result, { conversation_id: "CONV-1", originator_id: "ORIGIN-1" });
  assert.match(calls[1].url, /\/mpesa\/b2c\/v1\/paymentrequest$/);
  for (const payload of [{ ResponseCode: 0 }, { ResponseCode: 1 }, { ResponseCode: 0, ConversationID: "X", OriginatorConversationID: "" }]) {
    await assert.rejects(submitPayment({}, "synthetic", { env, fetcher: async () => json(payload) }), /do not resend/);
  }
  await assert.rejects(submitPayment({}, "synthetic", { env, fetcher: async () => { throw new Error("Timeout"); } }), /Timeout/);
});

test("credential encryption checks pinned certificate, validity, RSA and does not use STK passkey", () => {
  const dir = mkdtempSync(join(tmpdir(), "b2c-synthetic-cert-"));
  const openssl = process.platform === "win32" ? "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe" : "openssl";
  try {
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(dir, "key.pem"),
      "-out", join(dir, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=synthetic-b2c.test"], { stdio: "ignore" });
    const pem = readFileSync(join(dir, "cert.pem"), "utf8");
    const cert = new X509Certificate(pem);
    const configured = { ...env, DARAJA_B2C_CERTIFICATE_PEM: pem,
      DARAJA_B2C_CERTIFICATE_SHA256: cert.fingerprint256.replaceAll(":", "").toLowerCase() };
    assert.equal(Buffer.from(encryptInitiatorCredential(configured), "base64").length, 256);
    assert.throws(() => encryptInitiatorCredential({ ...configured, DARAJA_B2C_CERTIFICATE_SHA256: "0".repeat(64) }), /fingerprint/);
    assert.throws(() => encryptInitiatorCredential(configured, Date.parse(cert.validTo) + 1), /validity/);
    assert.throws(() => encryptInitiatorCredential(configured, Date.parse(cert.validFrom) - 1), /validity/);
    assert.throws(() => encryptInitiatorCredential({ ...configured, DARAJA_B2C_INITIATOR_PASSWORD: "", DARAJA_PASSKEY: "not-an-initiator" }), /credential/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
