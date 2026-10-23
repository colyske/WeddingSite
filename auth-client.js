// Session kept in sessionStorage (cleared when the tab closes). Tokens are never logged.
window.WS = {
  save(s) { sessionStorage.setItem("ws-session", JSON.stringify({ a: s.accessToken, r: s.refreshToken || "" })); },
  token() { try { return JSON.parse(sessionStorage.getItem("ws-session"))?.a || ""; } catch { return ""; } },
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
  money(minor, currency) {
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100); }
    catch { return (minor / 100).toFixed(2) + " " + currency; }
  },
  esc(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
};
