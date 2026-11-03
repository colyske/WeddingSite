import { createHash, randomBytes, randomUUID } from "node:crypto";
import { supabaseRequest } from "./supabase.js";
import { encryptInitiatorCredential, oauthToken, paymentRequest, providerReadiness, submitPayment, validConversation } from "./daraja-b2c.js";

export const capabilityHash = value => createHash("sha256").update(value).digest("hex");
const rpcDefault = (name, body, token, service = false) =>
  supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", body, token, service });
export const b2cReadiness = (env = process.env) => ({
  ...providerReadiness(env), autoApprovalGate: env.DARAJA_B2C_AUTO_APPROVAL_ENABLED === "true"
});

export async function dispatchB2c(payoutId, key, {
  env = process.env, rpc = rpcDefault, fetcher = fetch, encryptCredential = encryptInitiatorCredential
} = {}) {
  if (!b2cReadiness(env).ready) throw new Error("B2C: Dispatch prerequisites missing; no reservation or provider call made.");
  const credential = encryptCredential(env);
  const token = randomBytes(32).toString("hex");
  const hash = capabilityHash(token);
  const dispatch = await rpc("b2c_claim", {
    p_id: payoutId, p_key: key, p_callback_hash: hash, p_shortcode: env.DARAJA_B2C_SHORTCODE,
    p_command: env.DARAJA_B2C_COMMAND_ID, p_auto: env.DARAJA_B2C_AUTO_APPROVAL_ENABLED === "true"
  }, undefined, true);
  if (!dispatch?.claimed) return { dispatched: false, state: dispatch?.state, alreadyClaimed: true };
  const record = (kind, evidence) => rpc("b2c_event", {
    p_id: dispatch.id, p_hash: hash, p_kind: kind,
    p_key: capabilityHash(JSON.stringify({ kind, evidence })), p_evidence: evidence
  }, undefined, true);
  try {
    const request = paymentRequest(dispatch, token, credential, env);
    const accessToken = await oauthToken({ env, fetcher });
    const acceptance = await submitPayment(request, accessToken, { env, fetcher });
    const state = await record("accepted", acceptance);
    return { dispatchId: dispatch.id, dispatched: true, state, accepted: true, settled: false,
      held: state === "account_held", conflict: state === "account_held" };
  } catch {
    // The durable shared execution claim survives transport, OAuth and DB failures.
    // No errors/raw provider responses are logged: they may contain credentials.
    console.error("B2C dispatch requires reconciliation", dispatch.id);
    await record("uncertain", { reason: "transport_acceptance_or_persistence_uncertain" });
    return { dispatchId: dispatch.id, dispatched: false, state: "uncertain", reconciliationRequired: true };
  }
}

export function callbackEvidence(body) {
  const result = body?.Result;
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      !validConversation(result.ConversationID) || !validConversation(result.OriginatorConversationID)) return null;
  const code = result.ResultCode;
  if (!(Number.isSafeInteger(code) || (typeof code === "string" && /^-?\d{1,8}$/.test(code)))) return null;
  return {
    conversation_id: result.ConversationID, originator_id: result.OriginatorConversationID,
    result_code: String(Number(code)),
    transaction_id: typeof result.TransactionID === "string" && /^[A-Za-z0-9]{1,120}$/.test(result.TransactionID)
      ? result.TransactionID : null,
    // Parameter meanings/recipient identity are NOT inferred from position or name text.
    payload_sha256: capabilityHash(JSON.stringify(body))
  };
}

export async function receiveB2cCallback(dispatchId, token, kind, body, { rpc = rpcDefault } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token || "") || !["result", "timeout"].includes(kind)) {
    throw new Error("B2C: Invalid callback capability.");
  }
  const hash = capabilityHash(token);
  const context = await rpc("b2c_callback_context", { p_id: dispatchId, p_hash: hash }, undefined, true);
  if (!context?.id) throw new Error("B2C: Invalid callback capability.");
  const parsed = callbackEvidence(body);
  const bound = parsed && context.conversation_id === parsed.conversation_id && context.originator_id === parsed.originator_id;
  // Persist early callbacks by capability as inconclusive observations. Acceptance
  // binding can race them; no callback ever settles or frees shared reservations.
  const eventKind = bound ? kind : kind === "timeout" ? "timeout" : "uncertain";
  const evidence = bound ? parsed : {
    ...(parsed || {}),
    reason: parsed ? "unbound_or_mismatched_conversation" : "unverified_callback_schema",
    payload_sha256: capabilityHash(JSON.stringify(body))
  };
  const state = await rpc("b2c_event", {
    p_id: dispatchId, p_hash: hash, p_kind: eventKind,
    p_key: capabilityHash(JSON.stringify({ kind, body })), p_evidence: evidence
  }, undefined, true);
  return { state, held: state === "account_held", conflict: state === "account_held",
    reconciliationRequired: true, settled: false };
}

export async function runB2cWorker({ env = process.env, rpc = rpcDefault, fetcher = fetch, encryptCredential } = {}) {
  await rpc("b2c_mark_stale", {}, undefined, true);
  if (!b2cReadiness(env).ready) return { held: true, reason: "deployment_prerequisites" };
  const candidates = await rpc("b2c_candidates", {}, undefined, true);
  const results = [];
  // Skip held candidates, but make at most one provider attempt per invocation.
  for (const id of candidates.slice(0, 10)) {
    try {
      const result = await dispatchB2c(id, randomUUID(), { env, rpc, fetcher, encryptCredential });
      results.push(result);
      if (!result.alreadyClaimed) break;
    }
    catch {
      console.error("B2C candidate held", id);
      await rpc("b2c_candidate_hold", { p_id: id }, undefined, true);
      results.push({ payoutId: id, held: true, reason: "policy_funds_recipient_or_approval" });
    }
  }
  return { results };
}
