// Session kept in sessionStorage (cleared when the tab closes). Tokens are never logged.
window.WS = {
  save(s) { sessionStorage.setItem("ws-session", JSON.stringify({ a: s.accessToken, r: s.refreshToken || "", role: s.role || null })); },
  token() { try { return JSON.parse(sessionStorage.getItem("ws-session"))?.a || ""; } catch { return ""; } },
  role() { try { return JSON.parse(sessionStorage.getItem("ws-session"))?.role || null; } catch { return null; } },
  clear() { sessionStorage.removeItem("ws-session"); },
  async api(path, options = {}) {
    const send = () => fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}), Authorization: "Bearer " + WS.token() } });
    let res = await send();
    if (res.status === 401) {
      const refresh = (() => { try { return JSON.parse(sessionStorage.getItem("ws-session"))?.r; } catch { return ""; } })();
      if (refresh) {
        const r = await fetch("/api/auth?action=refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: refresh }) });
        if (r.ok) { WS.save(await r.json()); res = await send(); }
      }
    }
    return res;
  },
  money(minor, currency, showUsd = true) {
    try {
      const amount = minor / 100;
      const formatted = new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
      
      // If currency is already USD or USD display not requested, return just the formatted amount
      if (currency === "USD" || !showUsd) return formatted;
      
      // Try to convert to USD and show both
      if (typeof window.WeddingSiteFX !== "undefined" && window.WeddingSiteFX.hasRate) {
        const usdAmount = window.WeddingSiteFX.convertToUsd(amount, currency);
        if (usdAmount !== null) {
          const usdFormatted = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(usdAmount);
          return `${formatted} (${usdFormatted})`;
        }
      }
      
      return formatted;
    } catch { 
      const amount = (minor / 100).toFixed(2);
      if (currency === "USD" || !showUsd) return amount + " " + currency;
      return amount + " " + currency;
    }
  },
  esc(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
};
