(() => {
  const rateStatus = document.getElementById("facilitator-rate-status");
  const reward = document.getElementById("facilitator-reward");
  const exampleSection = document.getElementById("facilitator-example-section");
  const earningLead = document.getElementById("facilitator-earning-lead");
  const generalLead = document.getElementById("facilitator-general-lead");
  const earnings = document.getElementById("facilitator-earnings");
  const earningsNote = document.getElementById("facilitator-earnings-note");
  const formatRate = basisPoints => `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

  const loadRate = async () => {
    try {
      const response = await fetch("/api/referrals?action=public-rate", {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error("Rate request failed.");
      const policy = await response.json();
      if (policy?.enabled !== true || !Number.isInteger(policy.rate_basis_points)
        || policy.rate_basis_points < 1 || policy.rate_basis_points > 10000) {
        throw new Error("Rate is unavailable.");
      }

      const rateText = formatRate(policy.rate_basis_points);
      for (const element of document.querySelectorAll("[data-referral-rate]")) {
        element.textContent = rateText;
      }
      for (const element of document.querySelectorAll("[data-referral-amount]")) {
        const amount = Math.floor(Number(element.dataset.referralAmount) * policy.rate_basis_points / 10000);
        element.textContent = `KES ${new Intl.NumberFormat("en-KE").format(amount)}`;
      }
      reward.hidden = false;
      exampleSection.hidden = false;
      earnings.hidden = false;
      earningsNote.hidden = false;
      earningLead.hidden = false;
      generalLead.hidden = true;
      rateStatus.hidden = true;
    } catch {
      reward.hidden = true;
      exampleSection.hidden = true;
      earningLead.hidden = true;
      generalLead.hidden = false;
      rateStatus.textContent = "The current facilitator rate is unavailable right now. Please try again later.";
    }
  };

  if (rateStatus && reward && exampleSection && earningLead && generalLead && earnings && earningsNote) loadRate();

  for (const button of document.querySelectorAll("[data-copy-target]")) {
    const message = document.getElementById(button.dataset.copyTarget);
    const status = document.getElementById(button.dataset.copyStatus);
    if (!message || !status) continue;

    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(message.textContent.trim());
        status.textContent = button.dataset.copySuccess || "Message copied.";
      } catch {
        status.textContent = "Clipboard unavailable. Select and copy the message above.";
      }
    });
  }
})();
