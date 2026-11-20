(function () {
  "use strict";
  const key = "ws-client-referral";
  const defaultKey = "ws-client-referral-default";
  const defaultCode = "3b79b3fbb32894bf82dbaf21d2765deb";
  const codePattern = /^[a-f0-9]{32}$/;
  async function request(action, body) {
    const response = await WS.api("/api/referrals?action=" + action, body === undefined ? {} : {
      method: "POST", body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Referral request failed.");
    return data;
  }
  async function validate(code) {
    if (!codePattern.test(code)) throw new Error("The client referral link is invalid.");
    const response = await fetch("/api/referrals?action=validate&code=" + encodeURIComponent(code));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Referral validation is unavailable.");
    if (!data.valid) throw new Error("The client referral code is invalid or has been withdrawn.");
  }
  async function capture(code, isDefault) {
    await request("capture", { code, ...(isDefault ? { isDefault: true } : {}) });
  }
  async function prepare() {
    const url = new URL(location.href);
    const candidate = url.searchParams.get("client_ref");
    let stored = sessionStorage.getItem(key);
    let isDefault = stored === defaultCode && sessionStorage.getItem(defaultKey) === "1";
    if (candidate && (!stored || (isDefault && candidate !== defaultCode))) {
      await validate(candidate);
      sessionStorage.setItem(key, candidate);
      stored = candidate;
      isDefault = false;
      sessionStorage.removeItem(defaultKey);
    }
    if (candidate) {
      url.searchParams.delete("client_ref");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    if (WS.token() && stored) {
      await capture(stored, isDefault);
    }
  }
  function clear() {
    sessionStorage.removeItem(key);
    sessionStorage.removeItem(defaultKey);
    const url = new URL(location.href);
    url.searchParams.delete("client_ref");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  function consume() {
    sessionStorage.removeItem(key);
    sessionStorage.removeItem(defaultKey);
  }
  function money(minor, currency) {
    const value = BigInt(minor);
    const sign = value < 0n ? "-" : "";
    const absolute = value < 0n ? -value : value;
    return `${currency} ${sign}${(absolute / 100n).toLocaleString()}.${String(absolute % 100n).padStart(2, "0")}`;
  }
  window.WSReferrals = { prepare, request, clear, consume, money };
})();
