// Session kept in sessionStorage (cleared when the tab closes). Tokens are never logged.
window.WS = {
  session() { try { return JSON.parse(sessionStorage.getItem("ws-session")) || {}; } catch { return {}; } },
  save(s) {
    const previous = WS.session();
    const user = s.user || previous.user || {};
    sessionStorage.setItem("ws-session", JSON.stringify({
      a: s.accessToken || previous.a || "",
      r: s.refreshToken || previous.r || "",
      role: s.role || previous.role || previous.r || null,
      user,
      n: s.displayName || s.name || user.displayName || user.user_metadata?.display_name || user.user_metadata?.full_name || previous.n || "",
      e: user.email || previous.e || ""
    }));
  },
  token() { return WS.session().a || ""; },
  role() { const session = WS.session(); return session.role || session.r || null; },
  name() { const session = WS.session(); return session.n || session.user?.user_metadata?.display_name || session.user?.user_metadata?.full_name || ""; },
  email() { const session = WS.session(); return session.e || session.user?.email || ""; },
  setName(name) {
    const session = WS.session();
    session.n = name;
    sessionStorage.setItem("ws-session", JSON.stringify(session));
  },
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
  money(minor, currency, showUsd = false) {
    if (minor === null || minor === undefined || minor === "" || !Number.isFinite(Number(minor))) {
      console.error("Amount unavailable: expected a numeric minor-unit amount.");
      return "Amount unavailable";
    }
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
