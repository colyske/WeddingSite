// Phone numbers are the primary guest identifier. Stored as digits only, with a country code.
// A local number with a leading 0 is assumed to be Kenyan (+254) unless a country code is given.
export function normalizePhone(value) {
  let digits = String(value || "").replace(/[^\d+]/g, "");
  const international = digits.startsWith("+") || digits.startsWith("00");
  digits = digits.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!international && digits.startsWith("0") && digits.length === 10) digits = "254" + digits.slice(1);
  return digits.length >= 8 && digits.length <= 15 ? digits : "";
}

export const phoneKeyEmail = phone => `p${phone}@phone.weddingsite.invalid`;
export const isPhoneKeyEmail = email => /@phone\.weddingsite\.invalid$/i.test(String(email || ""));
