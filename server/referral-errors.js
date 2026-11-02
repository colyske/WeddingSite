export function referralError(error) {
  const message = String(error?.message || "");
  if (/REFERRAL_CONFLICT:/.test(message)) return [409, message.split("REFERRAL_CONFLICT:")[1].trim()];
  if (/Self referral/.test(message)) return [403, "You cannot refer your own wedding or a linked client account."];
  if (/authentication required/i.test(message)) return [401, "Sign in to use client referrals."];
  if (/Invalid or withdrawn referral code/.test(message)) return [400, "This referral code is invalid or has been withdrawn. You can decline the referral and continue."];
  if (/Review the current referral terms|Confirm a valid referral policy/.test(message)) return [400, "Review the current terms and confirm valid referral settings."];
  if (/permission denied|access denied|staff|owner|leadership/i.test(message)) return [403, "Your role does not allow this referral action."];
  return [503, "The referral service could not complete the request."];
}
