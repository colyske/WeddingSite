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
      if (!response.ok) throw new Error(data.error || "Paystack onboarding status is unavailable.");
      const row = data.onboarding;
      revision = row.revision;
      status.textContent = !row.verified ? "Not onboarded. Ask the platform Owner to verify your existing Paystack subaccount. No direct-settlement checkout can start."
        : !row.kycComplete ? "Paystack destination verified. Complete both partners' required details and consent before receiving direct settlements."
          : row.consented ? "Paystack destination verified and consent recorded. Provider activation and market/currency checks still apply."
            : "Paystack destination verified. Confirm the receiving account with the platform Owner before consenting below.";
      consent.disabled = !row.verified || !row.kycComplete || row.consented;
      const settlements = document.getElementById("paystack-settlement-rows");
      settlements.replaceChildren();
      for (const payment of data.settlements || []) {
        const entry = document.createElement("p");
        entry.className = "fine";
        entry.textContent = payment.payment_status !== "paid" ? "Direct payment pending provider confirmation; no fulfillment or withdrawal credit."
          : `${WS.money(payment.couple_minor,payment.currency,false)} allocated to the couple; ${WS.money(payment.platform_minor,payment.currency,false)} to the platform; ${WS.money(payment.provider_fee_minor,payment.currency,false)} provider fee. ${payment.provider_settled ? "Provider settlement verified." : "Awaiting provider settlement reconciliation."} ${payment.adjustment_status ? "Refund/dispute status: " + payment.adjustment_status + "." : ""} Withdrawable here: zero. These are historical transaction allocations, not your current bank balance.`;
        settlements.append(entry);
      }
    } catch (error) { revision = null; status.textContent = error.message; consent.disabled = true; }
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
      if (!response.ok) throw new Error(data.error || "Paystack destination consent could not be saved.");
      await load();
    } catch (error) { status.textContent = error.message; consent.checked = false; }
  });
  document.getElementById("paystack-onboarding-reload").addEventListener("click", load);
  load();
})();
