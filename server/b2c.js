import { createHash, randomBytes, randomUUID, publicEncrypt, constants, X509Certificate } from "node:crypto";
import { supabaseRequest } from "./supabase.js";

const COMMANDS = new Set(["BusinessPayment", "SalaryPayment", "PromotionPayment"]);
const API_HOST = "https://api.safaricom.co.ke";
export const capabilityHash = token => createHash("sha256").update(token).digest("hex");
const rpcDefault = (name, body, token, service = false) =>
  supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", body, token, service });

function secureOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === "/" &&
      !/^(localhost|127\.|0\.|10\.|192\.168\.|\[)/i.test(url.hostname);
  } catch { return false; }
}

export function b2cReadiness(env = process.env) {
  const checks = {
    liveMode: env.WEDDINGSITE_PAYMENT_MODE === "live",
    production: env.DARAJA_ENVIRONMENT === "production",
    killSwitch: env.DARAJA_B2C_ENABLED === "true",
    // v1 is deliberately unsupported until its correlation contract can be verified.
    version: env.DARAJA_B2C_API_VERSION === "v3",
    contract: env.DARAJA_B2C_CONTRACT_VERIFIED === "true",
    capability: env.DARAJA_B2C_CAPABILITY_CONFIRMED === "true",
    shortcode: /^\d{5,7}$/.test(env.DARAJA_B2C_SHORTCODE || "") &&
      env.DARAJA_B2C_SHORTCODE === env.DARAJA_B2C_SHORTCODE_CONFIRMED,
    command: COMMANDS.has(env.DARAJA_B2C_COMMAND_ID),
    credentials: Boolean(env.DARAJA_CONSUMER_KEY && env.DARAJA_CONSUMER_SECRET &&
      env.DARAJA_B2C_INITIATOR_NAME && env.DARAJA_B2C_INITIATOR_PASSWORD),
    certificate: Boolean(env.DARAJA_B2C_CERTIFICATE_PEM && env.DARAJA_B2C_CERTIFICATE_SHA256),
    callbackOrigin: secureOrigin(env.WEDDINGSITE_PUBLIC_ORIGIN)
  };
  return { ready: Object.values(checks).every(Boolean), checks, autoApprovalGate: env.DARAJA_B2C_AUTO_APPROVAL_ENABLED === "true" };
}

export function encryptInitiatorCredential(env = process.env) {
  const certificate = new X509Certificate(env.DARAJA_B2C_CERTIFICATE_PEM);
  const actual = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
  const expected = String(env.DARAJA_B2C_CERTIFICATE_SHA256 || "").replaceAll(":", "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected ||
      certificate.publicKey.asymmetricKeyType !== "rsa" ||
      Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) < Date.now() ||
      !env.DARAJA_B2C_INITIATOR_PASSWORD) {
    throw new Error("B2C: The independently confirmed production certificate is missing, expired or mismatched.");
  }
  return publicEncrypt({ key: certificate.publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(env.DARAJA_B2C_INITIATOR_PASSWORD, "utf8")).toString("base64");
}

async function providerJson(fetcher, url, options) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (!response.ok) throw new Error(`B2C provider HTTP ${response.status}.`);
  return response.json();
}

export async function dispatchB2c(payoutId, key, token, {
  env = process.env, rpc = rpcDefault, fetcher = fetch, encryptCredential = encryptInitiatorCredential
} = {}) {
  if (!b2cReadiness(env).ready) throw new Error("B2C: Dispatch prerequisites are missing; no provider call was made.");
  const securityCredential = encryptCredential(env);
  const callbackToken = randomBytes(32).toString("hex");
  const originator = randomUUID();
  const d = await rpc("b2c_reserve", {
    p_payout: payoutId, p_key: key, p_originator: originator, p_callback_hash: capabilityHash(callbackToken),
    p_shortcode: env.DARAJA_B2C_SHORTCODE, p_command: env.DARAJA_B2C_COMMAND_ID,
    p_allow_auto: env.DARAJA_B2C_AUTO_APPROVAL_ENABLED === "true"
  }, token);
  if (!d.claimed) return { dispatchId: d.dispatch_id, state: d.state, dispatched: false };
  if (!Number.isSafeInteger(Number(d.amount_minor)) || Number(d.amount_minor) <= 0 || Number(d.amount_minor) % 100 !== 0) {
    await rpc("b2c_record_event", { p_dispatch: d.id, p_kind: "uncertain", p_event_key: "invalid_reserved_amount", p_evidence: {} }, undefined, true);
    throw new Error("B2C: Invalid reserved amount; human reconciliation required.");
  }
  const record = (kind, evidence) => rpc("b2c_record_event", {
    p_dispatch: d.id, p_kind: kind, p_event_key: randomUUID(), p_evidence: evidence
  }, undefined, true);
  try {
    const oauth = await providerJson(fetcher, `${API_HOST}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${Buffer.from(`${env.DARAJA_CONSUMER_KEY}:${env.DARAJA_CONSUMER_SECRET}`).toString("base64")}` }
    });
    if (typeof oauth.access_token !== "string" || !oauth.access_token) throw new Error("B2C OAuth response missing token.");
    const callback = kind => `${env.WEDDINGSITE_PUBLIC_ORIGIN.replace(/\/$/, "")}/api/b2c?action=${kind}&dispatch=${d.id}&token=${callbackToken}`;
    // Candidate v3 contract. Deployment must confirm it against the official account docs before enabling.
    const response = await providerJson(fetcher, `${API_HOST}/mpesa/b2c/v3/paymentrequest`, {
      method: "POST", headers: { Authorization: `Bearer ${oauth.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        OriginatorConversationID: d.originator_id, InitiatorName: env.DARAJA_B2C_INITIATOR_NAME,
        SecurityCredential: securityCredential, CommandID: d.command_id, Amount: Number(d.amount_minor) / 100,
        PartyA: d.shortcode, PartyB: d.msisdn, Remarks: `Wedding payout ${d.id}`,
        QueueTimeOutURL: callback("timeout"), ResultURL: callback("result"), Occasion: d.id
      })
    });
    if (String(response.ResponseCode) !== "0" || response.OriginatorConversationID !== d.originator_id ||
        typeof response.ConversationID !== "string" || !response.ConversationID || response.ConversationID.length > 160) {
      throw new Error("B2C acceptance missing or uncorrelated; do not retry.");
    }
    const state = await record("accepted", { originator_id: response.OriginatorConversationID, conversation_id: response.ConversationID });
    return { dispatchId: d.id, state, dispatched: true };
  } catch (error) {
    // Even a lost database response after acceptance cannot authorize another send.
    console.error("B2C dispatch outcome uncertain", d.id, error.message);
    await record("uncertain", { reason: "transport_or_acceptance_uncertain" });
    return { dispatchId: d.id, state: "uncertain", dispatched: false, reconciliationRequired: true };
  }
}

// Missing official result-field verification never turns a plausible callback into a settlement.
export function resultEvidence(result, dispatch, env = process.env) {
  const uncertain = { outcome: "inconclusive", verified_contract: false };
  if (env.DARAJA_B2C_CONTRACT_VERIFIED !== "true" || !env.DARAJA_B2C_RESULT_MAPPING) return uncertain;
  let mapping;
  try { mapping = JSON.parse(env.DARAJA_B2C_RESULT_MAPPING); }
  catch { throw new Error("B2C: Invalid official result mapping configuration."); }
  if (!mapping.amountParameter || !mapping.recipientParameter || !mapping.transactionParameter) {
    throw new Error("B2C: Official amount, recipient and receipt mapping required.");
  }
  if (result.ResultCode !== 0) return uncertain; // Failure callbacks may omit identity and amount; hold for statement review.
  const parameters = result.ResultParameters?.ResultParameter;
  if (!Array.isArray(parameters)) return uncertain;
  const values = new Map();
  for (const p of parameters) {
    if (!p || typeof p.Key !== "string" || values.has(p.Key)) return uncertain;
    values.set(p.Key, p.Value);
  }
  const amount = String(values.get(mapping.amountParameter) ?? "");
  const recipient = String(values.get(mapping.recipientParameter) ?? "");
  const receipt = String(values.get(mapping.transactionParameter) ?? "");
  // An exact MSISDN is required; never infer it from a recipient name or a registered-customer flag.
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || !/^254[17]\d{8}$/.test(recipient) ||
      !/^[A-Za-z0-9]{1,160}$/.test(receipt)) return uncertain;
  const [whole, cents = ""] = amount.split(".");
  const amountMinor = Number(whole) * 100 + Number(cents.padEnd(2, "0"));
  if (!Number.isSafeInteger(amountMinor) || amountMinor !== Number(dispatch.amount_minor) || recipient !== dispatch.msisdn) return uncertain;
  return { verified_contract: true, outcome: "succeeded", amount_minor: amountMinor, msisdn: recipient, transaction_id: receipt };
}

export async function receiveB2cCallback(dispatchId, token, kind, body, { env = process.env, rpc = rpcDefault } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token || "") || !["result", "timeout"].includes(kind)) throw new Error("B2C: Invalid callback capability.");
  const hash = capabilityHash(token);
  const d = await rpc("b2c_callback_context", { p_dispatch: dispatchId, p_hash: hash }, undefined, true);
  const result = body?.Result;
  if (!result || typeof result.ConversationID !== "string" ||
      result.ConversationID !== d.conversation_id || result.OriginatorConversationID !== d.originator_id) {
    // A callback racing the acceptance persistence gets a non-2xx response; nothing settles.
    await rpc("b2c_record_event", {
      p_dispatch: dispatchId, p_kind: "rejected", p_event_key: randomUUID(),
      p_evidence: { callback_hash: hash, reason: "callback_conversation_mismatch" }
    }, undefined, true);
    throw new Error("B2C: Unbound or mismatched callback conversation.");
  }
  const evidence = kind === "result" ? resultEvidence(result, d, env) : { outcome: "inconclusive", verified_contract: false };
  return rpc("b2c_record_event", {
    p_dispatch: dispatchId, p_kind: kind,
    p_event_key: capabilityHash(JSON.stringify({ kind, result })),
    p_evidence: { ...evidence, callback_hash: hash, conversation_id: result.ConversationID, originator_id: result.OriginatorConversationID }
  }, undefined, true);
}

export async function runB2cWorker({ env = process.env, rpc = rpcDefault, fetcher = fetch } = {}) {
  // Housekeeping never calls Daraja and must continue after an emergency admission stop.
  await rpc("b2c_mark_stale", {}, undefined, true);
  if (!b2cReadiness(env).ready) return { held: true, reason: "deployment_gates_closed" };
  const policy = await rpc("b2c_worker_policy", {}, undefined, true);
  if (!policy.dispatch_enabled) return { held: true, reason: "owner_dispatch_gate_closed" };
  const candidates = await rpc("b2c_candidates", {}, undefined, true);
  const results = [];
  for (const payout of candidates) {
    results.push(await dispatchB2c(payout, payout, undefined, {
      env, fetcher, rpc: (name, body, token, service) => rpc(name, body, token, service || name === "b2c_reserve")
    }));
  }
  return { results };
}
