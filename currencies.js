(function (root) {
  // Match paystack_accounting_currency_supported; ICU versions disagree on some
  // default exponents (e.g. COP, HUF, IDR), but stored wedding units do not change.
  const accountingCodes = Object.freeze("AED,AMD,ANG,AOA,ARS,AUD,AWG,AZN,BAM,BBD,BDT,BGN,BMD,BND,BOB,BRL,BSD,BTN,BWP,BYN,BZD,CAD,CDF,CHF,CNY,COP,CRC,CUC,CUP,CVE,CZK,DKK,DOP,DZD,EGP,ERN,ETB,EUR,FJD,FKP,GBP,GEL,GHS,GIP,GMD,GTQ,GYD,HKD,HNL,HRK,HTG,HUF,IDR,ILS,INR,JMD,KES,KGS,KHR,KYD,KZT,LKR,LRD,LSL,MAD,MDL,MKD,MNT,MOP,MRU,MUR,MVR,MWK,MXN,MYR,MZN,NAD,NGN,NIO,NOK,NPR,NZD,PAB,PEN,PGK,PHP,PKR,PLN,QAR,RON,RUB,SAR,SBD,SCR,SDG,SEK,SGD,SHP,SLE,SRD,SSP,STN,SVC,SZL,THB,TJS,TMT,TOP,TRY,TTD,TWD,TZS,UAH,USD,UYU,UZS,VES,WST,XCD,XCG,XDR,XSU,ZAR,ZMW,ZWG,ZWL".split(","));
  const displayCodes = Object.freeze([...new Set([...Intl.supportedValuesOf("currency"), ...accountingCodes])].sort());
  const exponents = new Map();
  const exponent = code => {
    if (accountingCodes.includes(code)) return 2;
    if (exponents.has(code)) return exponents.get(code);
    if (!displayCodes.includes(code)) throw new Error("Choose a supported ISO currency.");
    const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
    exponents.set(code, digits);
    return digits;
  };
  // Existing wedding accounting and purchase forms store hundredths throughout.
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
