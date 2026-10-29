/**
 * Browser: <script src="contact-policy.js"></script>, then WSContactPolicy.hasContact(text).
 * Node (ESM): import "./contact-policy.js"; const policy = globalThis.WSContactPolicy;
 *
 * validate(value, { exemptKeys, exemptPaths }) recursively checks string values.
 * Exemptions skip entire subtrees; paths start at "$", e.g. "$.sponsor.socialLinks".
 * No fields are exempt by default. Callers must explicitly exempt designated contact
 * fields and sponsor social links, using their own trusted schema, not user input.
 * assert(value, options) returns value or throws with code, path and the policy message.
 * message is also available directly as WSContactPolicy.message.
 * Spelled phones support consecutive English digit words (zero through nine),
 * not arbitrary number prose or translations.
 * This is a conservative text heuristic, not a phone-number/address authenticity check.
 */
(function (root) {
  "use strict";

  const message = "Use the designated contact fields for phone numbers and email addresses.";
  const digitStarts = [
    0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6,
    0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50,
    0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810,
  ];

  function normalize(value) {
    return value.normalize("NFKC")
      .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f]/gu, "")
      .replace(/[\u2010-\u2015\u2212]/gu, "-")
      .replace(/[\u3002\uff61]/gu, ".")
      .replace(/\p{Decimal_Number}/gu, (digit) => {
        const code = digit.codePointAt(0);
        const start = digitStarts.find((first) => code >= first && code < first + 10);
        return start === undefined ? digit : String(code - start);
      });
  }

  function hasEmail(text) {
    const expanded = text
      .replace(/\[\s*(?:at|@)\s*\]|\(\s*(?:at|@)\s*\)|\{\s*(?:at|@)\s*\}|\bat\b/giu, "@")
      .replace(/\[\s*(?:dot|\.)\s*\]|\(\s*(?:dot|\.)\s*\)|\{\s*(?:dot|\.)\s*\}|\bdot\b/giu, ".");
    return /[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\s*\.\s*[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+)*\s*@\s*[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\s*\.\s*[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\s*\.\s*\p{L}{2,}(?![\p{L}\p{N}-])/iu.test(expanded);
  }

  const currency = "(?:\\p{Sc}|\\b(?:KES|KSHS?|USD|EUR|GBP|TZS|UGX|ZAR|NGN|INR|CAD|AUD|AED)\\b)";
  const amount = "(?:\\d{1,3}(?:[,\\u0020]\\d{3})+|\\d+)(?:\\.\\d{1,2})?";
  const currencyAmount = new RegExp(
    `${currency}\\s*${amount}(?![\\d.])|(?<![\\d.])${amount}\\s*${currency}`, "giu",
  );

  function phoneText(text) {
    return text
      .replace(currencyAmount, "|")
      // Mask dates before scanning: adjacent times or dates must not form a phone.
      .replace(/(?<!\d)(?:19|20|21)\d{2}([-/.])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])(?!\d)/gu, "|")
      .replace(/(?<!\d)(?:0?[1-9]|[12]\d|3[01])([-/.])(?:0?[1-9]|1[0-2])\1(?:(?:19|20|21)\d{2}|\d{2})(?!\d)/gu, "|")
      .replace(/(?<!\d)(?:0?[1-9]|1[0-2])([-/.])(?:0?[1-9]|[12]\d|3[01])\1(?:(?:19|20|21)\d{2}|\d{2})(?!\d)/gu, "|")
      .replace(/\b(?:19|20|21)\d{2}(?:\s*[-,]?\s+(?:19|20|21)\d{2})+\b/gu, "|");
  }

  function plausiblePhone(candidate) {
    // Decimal amounts are ambiguous, but not a common complete phone format.
    // Check the whole candidate so a decimal-looking phone suffix is not removed.
    if (/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?: \d{3})+)\.\d{2}$/u.test(candidate.trim())) {
      return false;
    }
    const digits = candidate.replace(/\D/g, "");
    const internationalPrefix = candidate.trim().startsWith("+") || digits.startsWith("00");
    const significantDigits = digits.startsWith("00") ? digits.slice(2) : digits;
    if (significantDigits.length > 15) {
      // Preserve detection when multiple unformatted numbers share a separator.
      return candidate.split(/\s+/u).some((part) => {
        const count = part.replace(/\D/g, "").length;
        return count >= 9 && count <= 15 && plausiblePhone(part);
      });
    }
    if (internationalPrefix) {
      return /^[1-9]\d{6,14}$/.test(significantDigits);
    }
    return /^[17]\d{8}$/.test(digits) || /^\d{10,15}$/.test(digits);
  }

  const digitWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const digitWord = `(?:${digitWords.join("|")})`;
  const spelledPhone = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:plus[\\s-]+)?${digitWord}(?:[\\s-]+${digitWord}){8,}(?![\\p{L}\\p{N}_])`,
    "giu",
  );

  function hasSpelledPhone(text) {
    const candidates = text.match(spelledPhone) || [];
    return candidates.some((candidate) => {
      const words = candidate.toLowerCase().split(/[\s-]+/u);
      const prefix = words[0] === "plus" ? "+" : "";
      if (prefix) words.shift();
      return plausiblePhone(prefix + words.map((word) => digitWords.indexOf(word)).join(""));
    });
  }

  function hasContact(value) {
    if (typeof value !== "string" || !value) return false;
    const text = normalize(value);
    if (hasEmail(text) || hasSpelledPhone(text)) return true;
    const candidates = phoneText(text).match(/[+(\d][\d\s().-]*\d/gu) || [];
    return candidates.some(plausiblePhone);
  }

  function validate(value, { exemptKeys = [], exemptPaths = [] } = {}) {
    const keys = new Set(exemptKeys);
    const paths = new Set(exemptPaths);
    const ancestors = new WeakSet();

    function visit(current, path) {
      if (paths.has(path)) return null;
      if (typeof current === "string") return hasContact(current) ? path : null;
      if (!current || typeof current !== "object" || ancestors.has(current)) return null;
      ancestors.add(current);
      for (const [key, child] of Object.entries(current)) {
        if (keys.has(key)) continue;
        const childPath = Array.isArray(current) ? `${path}[${key}]` : `${path}.${key}`;
        const found = visit(child, childPath);
        if (found !== null) {
          ancestors.delete(current);
          return found;
        }
      }
      ancestors.delete(current);
      return null;
    }

    const path = visit(value, "$");
    return path === null
      ? { valid: true, message: null, path: null }
      : { valid: false, message, path };
  }

  function assert(value, options) {
    const result = validate(value, options);
    if (!result.valid) {
      const error = new Error(message);
      error.code = "CONTACT_INFO_NOT_ALLOWED";
      error.path = result.path;
      throw error;
    }
    return value;
  }

  root.WSContactPolicy = Object.freeze({ hasContact, validate, assert, message });
})(globalThis);
