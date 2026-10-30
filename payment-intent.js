// Browser-side guard for one payment intent: one idempotency key per intent, and no second
// initiation while an earlier one may be outstanding. State survives reloads via sessionStorage.
(function (root) {
  const newKey = () => (root.crypto?.randomUUID ? root.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`);
  // Every field that distinguishes one paid action from another (the anti-abuse token is per-attempt).
  const signature = payload => JSON.stringify(Object.keys(payload).filter(k => k !== "captchaToken" && k !== "idempotencyKey")
    .sort().map(k => [k, payload[k] === undefined ? null : payload[k]]));
  const defaultStorage = () => { try { return root.sessionStorage || null; } catch { return null; } };
  const create = (options = {}) => {
    const storage = "storage" in options ? options.storage : defaultStorage();
    const slot = `ws-pay-intent:${options.name || "default"}`;
    let state = { key: "", sig: "", paymentId: "", uncertain: false };
    try { state = { ...state, ...JSON.parse(storage?.getItem(slot) || "{}") }; } catch { /* start clean */ }
    const save = () => { try { storage?.setItem(slot, JSON.stringify(state)); } catch { /* memory only */ } };
    return {
      get heldPaymentId() { return state.paymentId; },
      get uncertain() { return state.uncertain; },
      // Resolves to { kind: "started" | "held" | "uncertain" | "blocked" | "error", data, message }.
      async submit(payload, fetchImpl = root.fetch.bind(root)) {
        if (state.paymentId) return { kind: "blocked", data: { paymentId: state.paymentId } };
        const next = signature(payload);
        if (state.uncertain && next !== state.sig) {
          return { kind: "blocked", message: "An earlier request may already have been sent. Check your phone and wait for it to resolve before changing details." };
        }
        if (!state.key || next !== state.sig) { state = { key: newKey(), sig: next, paymentId: "", uncertain: false }; save(); }
        let res;
        let data;
        try {
          res = await fetchImpl("/api/checkout?action=create", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, idempotencyKey: state.key })
          });
          data = await res.json();
        } catch {
          // The request may have reached the server: keep the same key and never treat this as a clean failure.
          state.uncertain = true; save();
          return { kind: "uncertain", message: "We could not confirm whether the payment request was sent. Check your phone before trying again; retrying reuses the same request and will not charge twice." };
        }
        if (res.ok && data && data.paymentId) {
          state.paymentId = String(data.paymentId); save();
          return { kind: "started", data };
        }
        if (res.ok) {
          state.uncertain = true; save();
          return { kind: "uncertain", data, message: "The payment service gave an unexpected reply, so the request may have been sent. Check your phone before trying again." };
        }
        if (data && data.paymentId) {
          state.paymentId = String(data.paymentId); save();
          return { kind: "held", data, message: data.error };
        }
        return { kind: "error", data, message: (data && data.error) || "Checkout could not be started." };
      },
      release() {
        state = { key: "", sig: "", paymentId: "", uncertain: false };
        try { storage?.removeItem(slot); } catch { /* ignore */ }
      }
    };
  };
  const payLabel = (provider, mode) => provider === "daraja"
    ? (mode === "live" ? "Send M-Pesa prompt (real money)" : "Send M-Pesa prompt (sandbox)")
    : "Pay (test mode)";
  const darajaNote = mode => mode === "live"
    ? "LIVE payment: this sends a real M-Pesa prompt and charges real money. Approve it on this phone only if you intend to pay; the action stays pending until Safaricom confirms it."
    : "Sandbox test: use only a Safaricom test number. A real phone can still be prompted and charged even in sandbox, so do not enter a real personal number. The action stays pending until payment is confirmed.";
  root.WSPaymentIntent = Object.freeze({ create, payLabel, darajaNote });
  if (typeof module !== "undefined" && module.exports) module.exports = root.WSPaymentIntent;
})(globalThis);
