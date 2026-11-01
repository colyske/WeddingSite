import { supabaseRequest } from "./supabase.js";

// Settles a Daraja payment that was wrongly cancelled while Safaricom still reported it
// as processing. Only call with a result from verifyProviderPayment that has verified=true;
// the RPC re-checks the bound reference and reopens + settles atomically.
export async function recoverVerifiedDaraja(payment, contributionId) {
  if (!payment?.verified || payment.provider !== "daraja") {
    throw new Error("Only an independently verified Daraja payment can be recovered.");
  }
  return supabaseRequest("/rest/v1/rpc/recover_verified_daraja_payment", {
    service: true, method: "POST",
    body: {
      p_provider_event_id: payment.eventId,
      p_contribution_id: contributionId,
      p_amount_minor: payment.amountMinor,
      p_currency: payment.currency,
      p_provider_reference: payment.reference,
      p_provider_payment_reference: payment.providerPaymentReference
    }
  });
}
