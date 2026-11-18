import { supabaseRequest } from "./supabase.js";

const rpc = (name, body = {}) => supabaseRequest(`/rest/v1/rpc/${name}`, {
  service: true, method: "POST", body
});

export async function stageVerifiedAdjustment(adjustment, payloadDigest) {
  const staged = await rpc("stage_verified_adjustment", {
    p_provider: adjustment.provider,
    p_event_id: adjustment.eventId,
    p_event_type: adjustment.eventType,
    p_adjustment_id: adjustment.adjustmentId,
    p_payment_reference: adjustment.paymentReference,
    p_amount_minor: adjustment.amountMinor,
    p_currency: adjustment.currency,
    p_state: adjustment.state,
    p_occurred_at: adjustment.occurredAt,
    p_payload_sha256: payloadDigest
  });
  if (!staged?.id || staged.conflict) {
    throw new Error("Verified adjustment identity conflict requires investigation.");
  }
  return processVerifiedAdjustment(staged.id);
}

async function processVerifiedAdjustment(id) {
  const result = await rpc("process_verified_adjustment", { p_id: id });
  if (result?.processed !== true) throw new Error("Verified adjustment is held for investigation.");
  return result;
}

export async function runVerifiedAdjustmentWorker() {
  const pending = await rpc("pending_verified_adjustments");
  if (!Array.isArray(pending?.ids) || !Number.isSafeInteger(pending.conflicts) || pending.conflicts < 0) {
    throw new Error("Verified adjustment queue is unavailable.");
  }
  let processed = 0, failed = 0;
  for (const id of pending.ids) {
    try {
      await processVerifiedAdjustment(id);
      processed++;
    } catch (error) {
      failed++;
      console.error("Verified adjustment worker requires retry", id, error.message);
      await rpc("note_verified_adjustment_failure", { p_id: id });
    }
  }
  if (pending.conflicts) console.error("Verified adjustment identities require investigation", pending.conflicts);
  return { processed, failed, conflicts: pending.conflicts };
}
