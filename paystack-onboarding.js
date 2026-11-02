(function () {
  const weddingId = new URLSearchParams(location.search).get("id");
  const panel = document.getElementById("paystack-onboarding");
  if (!panel || !weddingId) return;
  const status = document.getElementById("paystack-onboarding-status");
  const consent = document.getElementById("paystack-destination-consent");
  const button = document.getElementById("paystack-consent-submit");
  let revision = null;
  async function load() {
    button.disabled = true;
    consent.checked = false;
    try {
      const response = await WS.api(`/api/weddings?action=paystack-onboarding&weddingId=${encodeURIComponent(weddingId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error("Receiving account status is unavailable. Try again later.");
      const row = data.onboarding;
      revision = row.revision;
      status.textContent = row.settlementMode === "standard" ? "Guest payments are collected through the platform. No separate receiving-account consent is needed. Payout requests still require both partners' details and review."
        : !row.verified ? "The receiving account is not verified yet. Ask the platform Owner to review the account already on file. Direct settlement is not available until then."
        : !row.kycComplete ? "Receiving account verified. Add both partners' private identity details and consent before using direct settlement."
          : row.consented ? "Receiving account verified and consent saved. Availability still depends on your currency and location."
            : "Receiving account verified. Confirm the account with the platform Owner before giving consent below.";
      consent.disabled = row.settlementMode === "standard" || !row.verified || !row.kycComplete || row.consented;
      const settlements = document.getElementById("paystack-settlement-rows");
      settlements.replaceChildren();
      for (const payment of data.settlements || []) {
        const entry = document.createElement("p");
        entry.className = "fine";
        entry.textContent = payment.payment_status !== "paid" ? "Payment is waiting for confirmation. No order is fulfilled and no funds are available to withdraw."
          : `${WS.money(payment.couple_minor,payment.currency,false)} allocated to the couple; ${WS.money(payment.platform_minor,payment.currency,false)} to the platform; ${WS.money(payment.provider_fee_minor,payment.currency,false)} payment fee. ${payment.provider_settled ? "Transfer confirmed." : "Transfer confirmation is still pending."} ${payment.adjustment_status ? "Refund or dispute status: " + payment.adjustment_status + "." : ""} Available to withdraw here: zero. These are past payment amounts, not your current bank balance.`;
        settlements.append(entry);
      }
    } catch (error) {
      console.error("Receiving account status unavailable:", error);
      revision = null;
      status.textContent = "Receiving account status is unavailable. Try again later.";
      consent.disabled = true;
    }
  }
  consent.addEventListener("change", () => { button.disabled = !revision || !consent.checked; });
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const response = await WS.api("/api/weddings?action=paystack-consent", {
        method: "POST", body: JSON.stringify({ weddingId, revision, confirmed: consent.checked })
      });
      const data = await response.json();
      if (!response.ok) throw new Error("Your consent could not be saved. Check the receiving account and try again.");
      await load();
    } catch (error) {
      console.error("Receiving account consent failed:", error);
      status.textContent = "Your consent could not be saved. Check the receiving account and try again.";
      consent.checked = false;
    }
  });
  document.getElementById("paystack-onboarding-reload").addEventListener("click", load);
  load();
})();
