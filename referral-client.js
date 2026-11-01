(function () {
  "use strict";
  const key = "ws-client-referral";
  const codePattern = /^[a-f0-9]{32}$/;
  async function request(action, body) {
    const response = await WS.api("/api/referrals?action=" + action, body === undefined ? {} : {
      method: "POST", body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Referral request failed.");
    return data;
  }
  async function prepare() {
    const url = new URL(location.href);
    const candidate = url.searchParams.get("client_ref");
    let stored = sessionStorage.getItem(key);
    if (candidate && !stored) {
      if (!codePattern.test(candidate)) throw new Error("The client referral link is invalid.");
      const response = await fetch("/api/referrals?action=validate&code=" + encodeURIComponent(candidate));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Referral validation is unavailable.");
      if (!data.valid) throw new Error("The client referral code is invalid or has been withdrawn.");
      sessionStorage.setItem(key, candidate);
      stored = candidate;
    }
    if (candidate) {
      url.searchParams.delete("client_ref");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    if (WS.token() && stored) await request("capture", { code: stored });
  }
  function clear() {
    sessionStorage.removeItem(key);
    const url = new URL(location.href);
    url.searchParams.delete("client_ref");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  function money(minor, currency) {
    const value = BigInt(minor);
    const sign = value < 0n ? "-" : "";
    const absolute = value < 0n ? -value : value;
    return `${currency} ${sign}${(absolute / 100n).toLocaleString()}.${String(absolute % 100n).padStart(2, "0")}`;
  }
  window.WSReferrals = { prepare, request, clear, money };
})();
