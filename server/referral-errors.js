export function referralError(error) {
  const message = String(error?.message || "");
  if (/FACILITATOR_MANUAL_DISABLED:/.test(message)) return [503, "Facilitator payout requests are not available yet."];
  if (/FACILITATOR_MANUAL_(HOLD|CONFLICT):/.test(message)) return [409, message.split(/FACILITATOR_MANUAL_(?:HOLD|CONFLICT):/)[1].trim()];
  if (/FACILITATOR_MANUAL_INPUT:/.test(message)) return [400, message.split("FACILITATOR_MANUAL_INPUT:")[1].trim()];
  if (/FACILITATOR_MANUAL_AUTH:/.test(message)) return [403, "You cannot access this facilitator payout action."];
  if (/FACILITATOR_RECIPIENT_CONFLICT:/.test(message)) return [409, message.split("FACILITATOR_RECIPIENT_CONFLICT:")[1].trim()];
  if (/FACILITATOR_RECIPIENT_INPUT:/.test(message)) return [400, message.split("FACILITATOR_RECIPIENT_INPUT:")[1].trim()];
  if (/FACILITATOR_RECIPIENT_AUTH:/.test(message)) return [401, "Sign in to manage facilitator recipient details."];
  if (/SuperAdmin access required|Owner access required|Staff access required/i.test(message)) {
    return [403, "Your role does not allow this facilitator recipient action."];
  }
  if (/REFERRAL_CONFLICT:/.test(message)) return [409, message.split("REFERRAL_CONFLICT:")[1].trim()];
  if (/Self referral/.test(message)) return [403, "You cannot refer your own wedding or a linked client account."];
  if (/authentication required/i.test(message)) return [401, "Sign in to use client referrals."];
  if (/Invalid or withdrawn referral code/.test(message)) return [400, "This referral code is invalid or has been withdrawn. You can decline the referral and continue."];
  if (/Review the current referral terms|Confirm a valid referral policy/.test(message)) return [400, "Review the current terms and confirm valid referral settings."];
  if (/permission denied|access denied|staff|owner|leadership/i.test(message)) return [403, "Your role does not allow this referral action."];
  return [503, "The referral service could not complete the request."];
}
