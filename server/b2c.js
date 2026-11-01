import { createHash, randomUUID } from "node:crypto";
import { supabaseRequest } from "./supabase.js";

// These are implementation prerequisites, not operator-certifiable environment flags.
export const B2C_OFFICIAL_CONTRACT_IMPLEMENTED = false;
export const capabilityHash = token => createHash("sha256").update(token).digest("hex");
const rpcDefault = (name, body, token, service = false) =>
  supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", body, token, service });

export function b2cReadiness(env = process.env) {
  return {
    ready: false,
    checks: {
      implementedContract: B2C_OFFICIAL_CONTRACT_IMPLEMENTED,
      destinationOwnershipProcess: false,
      liveMode: env.WEDDINGSITE_PAYMENT_MODE === "live",
      production: env.DARAJA_ENVIRONMENT === "production",
      killSwitch: env.DARAJA_B2C_ENABLED === "true",
      reportedContractConfirmation: env.DARAJA_B2C_CONTRACT_VERIFIED === "true",
      reportedCapabilityConfirmation: env.DARAJA_B2C_CAPABILITY_CONFIRMED === "true"
    },
    autoApprovalGate: env.DARAJA_B2C_AUTO_APPROVAL_ENABLED === "true"
  };
}

export async function dispatchB2c() {
  throw new Error("B2C: Verified official contract and destination-ownership prerequisites are not implemented; no provider call or reservation was made.");
}

export function resultEvidence() {
  return { outcome: "inconclusive", verified_contract: false };
}

export async function receiveB2cCallback(dispatchId, token, kind, body, { rpc = rpcDefault } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token || "") || !["result", "timeout"].includes(kind)) {
    throw new Error("B2C: Invalid callback capability.");
  }
  const hash = capabilityHash(token);
  // Authenticate the dispatch capability, but do not parse an unverified provider schema.
  await rpc("b2c_callback_context", { p_dispatch: dispatchId, p_hash: hash }, undefined, true);
  await rpc("b2c_record_event", {
    p_dispatch: dispatchId, p_kind: "rejected", p_event_key: randomUUID(),
    p_evidence: { callback_hash: hash, reason: "official_callback_contract_not_implemented" }
  }, undefined, true);
  throw new Error("B2C: Official callback contract is not implemented; settlement remains blocked.");
}

export async function runB2cWorker({ rpc = rpcDefault } = {}) {
  // Hold/escalation continues after an admission stop; never retry or contact Daraja.
  await rpc("b2c_mark_stale", {}, undefined, true);
  return { held: true, reason: "official_contract_and_destination_ownership_not_implemented" };
}
