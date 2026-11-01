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
  // Buttons show the wedding currency only; any USD equivalent lives in a nearby fxNote.
  const label = (minor, currency) => {
    const units = minor / 100;
    return `${currency} ${units.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(units) ? 0 : 2, maximumFractionDigits: 2 })}`;
  };
  const fxNote = (minors, currency) => {
    const fx = root.WeddingSiteFX;
    if (currency === "USD" || !minors.length) return "";
    if (!fx?.isFresh?.() || !fx.hasRate?.(currency)) return "USD equivalent unavailable (no current exchange rate).";
    const usd = minors.map(minor => fx.convertToUsd(minor / 100, currency)).filter(Number.isFinite);
    if (usd.length !== minors.length) return "USD equivalent unavailable (no current exchange rate).";
    const low = Math.min(...usd).toFixed(2), high = Math.max(...usd).toFixed(2);
    const date = fx.rateDateIso?.() || "";
    return `≈ USD ${low === high ? low : `${low}–${high}`}; indicative daily FX${date ? ` ${date}` : ""}. You pay in ${currency}.`;
  };
  const refreshLabels = () => document.querySelectorAll("[data-preset-fx]").forEach(el => {
    const minors = el.dataset.presetFx.split(",").map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
    el.textContent = fxNote(minors, el.dataset.currency);
    el.hidden = !el.textContent;
  });
  root.WSAmountPresets = Object.freeze({ defaults, normalize, parse, amounts, label, fxNote });
  if (typeof document !== "undefined") document.addEventListener("weddingsitefxchange", refreshLabels);
})(globalThis);
