(function (root) {
  const displayCodes = Object.freeze(Intl.supportedValuesOf("currency"));
  const exponent = code => {
    if (!displayCodes.includes(code)) throw new Error("Choose a supported ISO currency.");
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  };
  // Existing wedding accounting and purchase forms store hundredths throughout.
  const accountingCodes = Object.freeze(displayCodes.filter(code => exponent(code) === 2));
  root.WSCurrencies = Object.freeze({
    displayCodes, accountingCodes, exponent,
    supportsAccounting: code => accountingCodes.includes(code)
  });
  if (typeof document !== "undefined") {
    const fill = () => document.querySelectorAll("select[data-wedding-currency]").forEach(select => {
      const selected = select.value || "USD";
      const names = new Intl.DisplayNames(undefined, { type: "currency" });
      select.replaceChildren(...["USD", ...accountingCodes.filter(code => code !== "USD")].map(code =>
        new Option(`${code} - ${names.of(code)}`, code)));
      select.value = accountingCodes.includes(selected) ? selected : "USD";
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill, { once: true });
    else fill();
  }
})(globalThis);
