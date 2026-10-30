// Browser-side guard for one payment intent: one idempotency key per intent, and no second
// initiation after the server reports an uncertain outcome for a retained payment.
(function (root) {
  const newKey = () => (root.crypto?.randomUUID ? root.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`);
  const signature = payload => JSON.stringify([
    payload.weddingId, payload.provider, payload.market, payload.purchaseAction, payload.refId,
    payload.amountMinor, payload.mpesaPhone, payload.email
  ]);
  const create = () => {
    let key = "";
    let sig = "";
    let heldPaymentId = "";
    return {
      get heldPaymentId() { return heldPaymentId; },
      // Resolves to { kind: "started" | "held" | "blocked" | "error", data, message }.
      async submit(payload, fetchImpl = root.fetch.bind(root)) {
        if (heldPaymentId) return { kind: "blocked", data: { paymentId: heldPaymentId } };
        const next = signature(payload);
        if (!key || next !== sig) { key = newKey(); sig = next; }
        let res;
        try {
          res = await fetchImpl("/api/checkout?action=create", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, idempotencyKey: key })
          });
        } catch {
          return { kind: "error", message: "Checkout could not be started. No action was completed." };
        }
        const data = await res.json().catch(() => ({}));
        if (res.ok) return { kind: "started", data };
        if (data.paymentId) {
          heldPaymentId = String(data.paymentId);
          return { kind: "held", data, message: data.error };
        }
        return { kind: "error", data, message: data.error || "Checkout could not be started." };
      },
      release() { heldPaymentId = ""; key = ""; sig = ""; }
    };
  };
  const payLabel = (provider, mode) => provider === "daraja"
    ? (mode === "live" ? "Send M-Pesa prompt (real money)" : "Send M-Pesa prompt (sandbox)")
    : "Pay (test mode)";
  const darajaNote = mode => mode === "live"
    ? "LIVE payment: this sends a real M-Pesa prompt and charges real money. Approve it on this phone only if you intend to pay; the action stays pending until Safaricom confirms it."
    : "Sandbox only: no real money moves. Approve the STK Push on this phone; the action stays pending until payment is confirmed.";
  root.WSPaymentIntent = Object.freeze({ create, payLabel, darajaNote });
  if (typeof module !== "undefined" && module.exports) module.exports = root.WSPaymentIntent;
})(globalThis);
