(() => {
  const apiUrl = "https://open.er-api.com/v6/latest/USD";
  const rateKey = "weddingsite-demo-fx-rates";
  const configKey = "weddingsite-demo-fee-config";
  const weddingKey = "weddingsite-demo-wedding-settings";
  const currencyKey = "weddingsite-demo-display-currency";
  const maxAgeHours = 36;
  const options = Intl.supportedValuesOf("currency");
  let rates = { USD: 1 };
  let rateDate = "";
  let fetchedAt = "";
  let state = "loading";
  let errorMessage = "";
  let ratePublishedText = "";

  function readSettings() {
    try {
      const config = JSON.parse(localStorage.getItem(configKey) || "null");
      const wedding = JSON.parse(localStorage.getItem(weddingKey) || "null");
      const savedCurrency = localStorage.getItem(currencyKey);
      const weddingCurrency = wedding?.tenants?.amara?.currency || wedding?.currency;
      const currency = options.includes(savedCurrency) ? savedCurrency : options.includes(weddingCurrency) ? weddingCurrency : options.includes(config?.currency) ? config.currency : "USD";
      return { currency, config };
    } catch {
      return { currency: "USD", config: null };
    }
  }
  function currency() { return readSettings().currency; }
  function rateAgeHours() {
    const updated = Date.parse(rateDate);
    return Number.isFinite(updated) ? Math.max(0, (Date.now() - updated) / 3600000) : Infinity;
  }
  function isFresh() { return Boolean(rates.USD === 1 && rateDate && rateAgeHours() <= maxAgeHours); }
  function hasRate(code) { return code === "USD" || Number.isFinite(rates[code]); }
  function convertBetween(amount, from, to) {
    if (!isFresh() || !Number.isFinite(amount) || !hasRate(from) || !hasRate(to)) return null;
    return amount / rates[from] * rates[to];
  }
  function fractionDigits(code) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  }
  function convertUsd(amount, code = currency()) {
    if (!Number.isFinite(amount) || !hasRate(code)) return null;
    const value = amount * rates[code];
    const scale = 10 ** fractionDigits(code);
    return Math.round(value * scale) / scale;
  }
  function convertToUsd(amount, code = currency()) {
    if (!Number.isFinite(amount) || !hasRate(code) || rates[code] === 0) return null;
    const converted = amount / rates[code];
    return Number.isFinite(converted) ? Math.round(converted * 100) / 100 : null;
  }
  function formatUsd(amount, code = currency(), locale = readSettings().config?.locale || "en-US") {
    const converted = convertUsd(amount, code);
    if (converted === null) return `USD ${Number(amount).toLocaleString("en-US")}`;
    return new Intl.NumberFormat(locale, { style: "currency", currency: code, maximumFractionDigits: fractionDigits(code) }).format(converted);
  }
  function formatPrimaryUsd(amount, code = currency(), locale = readSettings().config?.locale || "en-US") {
    const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(amount);
    if (code === "USD") return `${usd} USD`;
    const converted = convertUsd(amount, code);
    if (converted === null) return `${usd} USD [${code} equivalent unavailable]`;
    const formatted = formatUsd(amount, code, locale);
    return `${formatted}${formatted.includes(code) ? "" : ` ${code}`} [≈ ${usd} USD]`;
  }
  function statusText() {
    if (state === "loading" && !rateDate) return "Checking published FX rates…";
    if (state === "verifying-cache") return `Cached rate available · verifying latest ExchangeRate-API data · dated ${ratePublishedText || rateDate}.`;
    if (!rateDate) return `FX unavailable · showing USD only · ${errorMessage || "No cached rate"}`;
    const published = new Date(rateDate);
    const dateLabel = ratePublishedText || (Number.isNaN(published.getTime()) ? rateDate : published.toLocaleString());
    const checked = fetchedAt ? new Date(fetchedAt).toLocaleString() : "not fetched this session";
    if (state === "current") return `Latest published rate · ExchangeRate-API · dated ${dateLabel} · fetched ${checked}. Provider updates daily; converted figures are indicative.`;
    if (state === "cached") return `FX API unavailable (${errorMessage || "request failed"}) · using cached rate dated ${dateLabel} · last successful fetch ${checked}. Not live.`;
    if (state === "stale") return `STALE FX rate · ExchangeRate-API · dated ${dateLabel} · last successful fetch ${checked}. Converted figures may be outdated; confirm independently.`;
    return `FX unavailable · USD is shown as the canonical amount; no conversion is available for ${currency()}. ${errorMessage || "Rate service unavailable"}`;
  }
  function notifyChange() {
    document.dispatchEvent(new CustomEvent("weddingsitefxchange", { detail: { currency: currency(), state, rateDate, fetchedAt, message: statusText() } }));
  }
  function restoreCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(rateKey) || "null");
      if (!saved || saved.base !== "USD" || !saved.rates || typeof saved.rates !== "object") return;
      const entries = Object.entries(saved.rates).filter(([code, value]) => /^[A-Z]{3}$/.test(code) && Number.isFinite(value) && value > 0);
      rates = Object.fromEntries(entries);
      rates.USD = 1;
      rateDate = typeof saved.rateDate === "string" ? saved.rateDate : "";
      ratePublishedText = typeof saved.ratePublishedText === "string" ? saved.ratePublishedText : "";
      fetchedAt = typeof saved.fetchedAt === "string" ? saved.fetchedAt : "";
      state = isFresh() ? "verifying-cache" : "stale";
    } catch {
      errorMessage = "Saved FX data could not be read";
    }
  }
  async function refresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(apiUrl, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`rate service returned HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.result !== "success" || payload.base_code !== "USD" || !payload.rates || typeof payload.time_last_update_utc !== "string") throw new Error("rate service returned an invalid response");
      const nextRates = Object.fromEntries(Object.entries(payload.rates).filter(([code, value]) => /^[A-Z]{3}$/.test(code) && Number.isFinite(value) && value > 0));
      nextRates.USD = 1;
      rates = nextRates;
      rateDate = payload.time_last_update_utc;
      ratePublishedText = payload.time_last_update_utc;
      fetchedAt = new Date().toISOString();
      state = isFresh() ? "current" : "stale";
      errorMessage = "";
      try {
        localStorage.setItem(rateKey, JSON.stringify({ base: "USD", rates, rateDate, ratePublishedText, fetchedAt, provider: "open.er-api.com" }));
      } catch {
        errorMessage = "browser storage is unavailable";
        state = "unavailable";
      }
    } catch (error) {
      errorMessage = error.name === "AbortError" ? "request timed out" : error.message || "request failed";
      state = rateDate ? isFresh() ? "cached" : "stale" : "unavailable";
    } finally {
      clearTimeout(timeout);
      notifyChange();
    }
  }
  function choose(code) {
    if (!options.includes(code)) return false;
    localStorage.setItem(currencyKey, code);
    notifyChange();
    return hasRate(code);
  }
  restoreCache();
  window.WeddingSiteFX = {
    options, currency, choose, hasRate, convertUsd, convertToUsd,
    formatUsd, formatPrimaryUsd, formatDualUsd: formatPrimaryUsd, statusText, refresh,
    isFresh, convertBetween
  };
  window.addEventListener("storage", event => {
    if (event.key === currencyKey || event.key === configKey || event.key === weddingKey || event.key === rateKey) {
      if (event.key === rateKey) restoreCache();
      notifyChange();
    }
  });
  notifyChange();
  refresh();
})();
