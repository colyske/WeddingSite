(function (root) {
  const defaults = Object.freeze({ song: Object.freeze([500, 1000, 2500, 5000]), gift: Object.freeze([1000, 2500, 5000]) });
  const normalize = (value, currency, maxMinor) => {
    if (!root.WSCurrencies.supportsAccounting(currency)) throw new Error("Choose a supported two-decimal currency.");
    if (!Number.isSafeInteger(maxMinor) || maxMinor < 1) throw new Error("Suggested amount checkout limit is unavailable.");
    if (!value || value.currency !== currency) throw new Error("Review suggested amounts in the selected wedding currency.");
    const result = { currency };
    for (const kind of ["song", "gift"]) {
      const amounts = value[kind];
      if (!Array.isArray(amounts) || amounts.length < 1 || amounts.length > 6 ||
          amounts.some(n => !Number.isSafeInteger(n) || n < 100 || n > maxMinor)) {
        throw new Error("Enter 1 to 6 amounts per list, at least 1 in the wedding currency, with at most two decimals, within the checkout limit.");
      }
      result[kind] = [...new Set(amounts)].sort((a, b) => a - b);
    }
    return result;
  };
  const parse = text => String(text).split(",").map(part => {
    const value = part.trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("Use positive amounts separated by commas, with at most two decimals.");
    const minor = Math.round(Number(value) * 100);
    if (!Number.isSafeInteger(minor) || minor < 1) throw new Error("Suggested amounts must be positive finite values.");
    return minor;
  });
  const amounts = (wedding, kind) => {
    if (wedding.amount_presets == null) return defaults[kind];
    // Never reinterpret a saved list in another currency, even on a stale public response.
    return wedding.amount_presets.currency === wedding.currency ? wedding.amount_presets[kind] : [];
  };
  const label = (minor, currency) => root.WeddingSiteFX?.formatLocalIndicative
    ? root.WeddingSiteFX.formatLocalIndicative(minor / 100, currency)
    : `${currency} ${(minor / 100).toFixed(2)}`;
  const refreshLabels = () => document.querySelectorAll("[data-preset-money]").forEach(el => {
    el.textContent = label(Number(el.dataset.presetMoney), el.dataset.currency);
  });
  root.WSAmountPresets = Object.freeze({ defaults, normalize, parse, amounts, label });
  if (typeof document !== "undefined") document.addEventListener("weddingsitefxchange", refreshLabels);
})(globalThis);
