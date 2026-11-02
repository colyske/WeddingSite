(function (root) {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const labels = { giving: "Gift registry and fundraising", sponsors: "Sponsor packages",
    featured_sponsors: "Featured sponsor feature (campaign still needs separate setup)",
    song_requests: "Song requests", vip_seating: "VIP seating (review your offering below)" };
  function create(container, { onChange, onError } = {}) {
    let value = null, fictionalId = null, selectedCurrency = "";
    const changed = () => { value.reviewed = false; onChange?.(root.WSStarterSetup.clone(value)); };
    const input = (label, path, val, { money = false, max = 240 } = {}) =>
      `<label>${label}<input data-starter-path="${path}" value="${esc(val)}" ${money
        ? 'type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,2})?"'
        : `type="text" maxlength="${max}"`}></label>`;
    function render() {
      container.hidden = !value;
      if (!value) return;
      const currency = esc(value.currency || "not chosen");
      container.innerHTML = `<h3>Make the starter setup yours</h3>
        <p data-starter-disclosure>${fictionalId
          ? "Illustrative editable configuration, not real sponsorships or received funds. Sample amounts are hand-authored per currency, not an FX conversion."
          : "Public reusable settings only. All package, goal, milestone and meal labels are generic prompts, not the original couple's content. No paid activity or identities are copied."}</p>
        <p data-starter-currency>Amounts below are in <strong>${currency}</strong>. Choose your wedding currency above before accepting them. Changing currency clears all prices, fees and goals, never converts or relabels them.</p>
        <p data-starter-currency-warning role="status">${!selectedCurrency ? "Choose your accounting currency to edit prices." :
          fictionalId && !root.WSStarterSetup.hasSamples(selectedCurrency)
            ? "No illustrative amounts are provided for this currency. Enter your own prices and goals, or remove optional packages/goals." : ""}</p>
        ${fictionalId ? `<button type="button" data-starter-action="samples" ${!root.WSStarterSetup.hasSamples(selectedCurrency) ? "disabled" : ""}>Use illustrative amounts for ${esc(selectedCurrency || "my currency")} (review required)</button>` : ""}
        <fieldset><legend>Guest-facing features</legend>${root.WSStarterSetup.featureKeys.map(key =>
          `<label><input type="checkbox" data-starter-feature="${key}" ${value.features[key] ? "checked" : ""}> ${labels[key]}</label>`).join("")}</fieldset>
        <fieldset><legend>RSVP form options</legend>
          <p>Standard name, contact, attendance, party-size and dietary questions keep their existing behaviour. Only the supported fees and premium meal choices below are configurable; no guest answers are copied.</p>
          ${input("Base RSVP fee (0 = free)", "rsvp.fee", value.rsvp.fee, { money: true })}
          ${input("Extra guest fee (0 = free)", "rsvp.extraGuestFee", value.rsvp.extraGuestFee, { money: true })}
          ${input("Premium meal fee (0 = free)", "rsvp.premiumDietFee", value.rsvp.premiumDietFee, { money: true })}
          ${input("Premium meal choices (comma separated; optional)", "rsvp.premiumDietOptions", value.rsvp.premiumDietOptions.join(", "), { max: 410 })}
        </fieldset>
        <fieldset><legend>Sponsorship offerings / packages</legend>
          <p>These are offerings, not purchased sponsorships. Custom sponsorship minimums and checkout validation remain separate and unchanged.</p>
          ${value.tiers.map((tier, i) => `<fieldset><legend>Package ${i + 1}</legend>
            ${input("Package name", `tiers.${i}.name`, tier.name, { max: 60 })}
            ${input("Minimum package amount", `tiers.${i}.minAmount`, tier.minAmount, { money: true })}
            ${input("What you will offer", `tiers.${i}.perks`, tier.perks)}
            <button type="button" data-starter-action="remove-tier" data-index="${i}">Remove package ${i + 1}</button></fieldset>`).join("")}
          <button type="button" data-starter-action="add-tier" ${value.tiers.length >= 6 ? "disabled" : ""}>Add sponsor package</button>
        </fieldset>
        <fieldset><legend>Gift registry goals</legend>
          ${value.registry.map((item, i) => `<fieldset><legend>Gift goal ${i + 1}</legend>
            ${input("Gift goal name", `registry.${i}.name`, item.name, { max: 100 })}
            ${input("Category", `registry.${i}.category`, item.category, { max: 50 })}
            ${input("Description", `registry.${i}.description`, item.description)}
            ${input("Target amount", `registry.${i}.target`, item.target, { money: true })}
            <button type="button" data-starter-action="remove-registry" data-index="${i}">Remove gift goal ${i + 1}</button></fieldset>`).join("")}
          <button type="button" data-starter-action="add-registry" ${value.registry.length >= 20 ? "disabled" : ""}>Add gift goal</button>
        </fieldset>
        <fieldset><legend>VIP seating offering</legend>
          ${value.vip ? `${input("VIP title", "vip.title", value.vip.title, { max: 80 })}
            ${input("VIP description", "vip.description", value.vip.description)}
            ${input("Number of seats (1-500)", "vip.seats", value.vip.seats, { max: 3 })}
            ${input("Price per seat", "vip.price", value.vip.price, { money: true })}
            <button type="button" data-starter-action="remove-vip">Remove VIP offering</button>`
            : '<p>No seating offering copied.</p><button type="button" data-starter-action="add-vip">Add VIP offering</button>'}
        </fieldset>
        <fieldset><legend>Suggested guest amounts</legend>
          <p>Optional comma-separated suggestions (1-6 per list, minimum one major currency unit). These do not set custom sponsorship minimums or fixed offer prices. Leave both blank to use normal platform defaults.</p>
          ${input("Song suggestions", "amountPresets.song", value.amountPresets.song, { max: 100 })}
          ${input("Gift suggestions", "amountPresets.gift", value.amountPresets.gift, { max: 100 })}
        </fieldset>
        <fieldset><legend>Fundraising goals & milestones</legend>
          <p>Goals and targets only. New drafts start with zero received funds and no bids, transactions or supporters.</p>
          ${value.campaigns.map((campaign, i) => `<fieldset><legend>Goal ${i + 1}</legend>
            ${input("Goal name", `campaigns.${i}.name`, campaign.name, { max: 100 })}
            ${input("Purpose", `campaigns.${i}.purpose`, campaign.purpose)}
            ${input("Goal amount", `campaigns.${i}.goal`, campaign.goal, { money: true })}
            <label><input type="checkbox" data-starter-enabled="${i}" ${campaign.enabled ? "checked" : ""}> Show this goal after publishing (does not publish now)</label>
            ${campaign.milestones.map((milestone, j) => `<fieldset><legend>Milestone ${j + 1}</legend>
              ${input("Milestone name", `campaigns.${i}.milestones.${j}.name`, milestone.name, { max: 100 })}
              ${input("Target (no greater than the goal)", `campaigns.${i}.milestones.${j}.target`, milestone.target, { money: true })}
              ${input("Milestone description", `campaigns.${i}.milestones.${j}.description`, milestone.description)}
              <button type="button" data-starter-action="remove-milestone" data-index="${i}" data-milestone="${j}">Remove milestone ${j + 1}</button></fieldset>`).join("")}
            <button type="button" data-starter-action="add-milestone" data-index="${i}" ${campaign.milestones.length >= 10 ? "disabled" : ""}>Add milestone</button>
            <button type="button" data-starter-action="remove-campaign" data-index="${i}">Remove goal ${i + 1}</button></fieldset>`).join("")}
          <button type="button" data-starter-action="add-campaign" ${value.campaigns.length >= 6 ? "disabled" : ""}>Add fundraising goal</button>
        </fieldset>
        <fieldset><legend>Starter review checklist</legend>
          <p>Confirm your selected currency, every fee/price/goal, sponsor promises, meal labels, fundraising visibility and milestones. Replace illustrative/generic copy. You must still enter your own couple, date and venue answers before publishing.</p>
          <p>This creates only a new private draft: no provider, paid sponsor, guest response, payment, KYC, referral setting or publication readiness is inherited.</p>
          <label><input type="checkbox" data-starter-reviewed ${value.reviewed ? "checked" : ""}> I reviewed these editable settings and amounts in my chosen currency.</label>
        </fieldset>`;
      container.querySelectorAll('input[inputmode="decimal"]').forEach(control => { control.disabled = !selectedCurrency; });
    }
    container.addEventListener("input", event => {
      const control = event.target;
      if (!value || !control.matches("input")) return;
      if (control.hasAttribute("data-starter-reviewed")) {
        value.reviewed = control.checked;
        onChange?.(root.WSStarterSetup.clone(value));
        return;
      }
      if (control.dataset.starterPath) {
        const path = control.dataset.starterPath.split(".");
        const key = path.pop();
        const target = path.reduce((object, part) => object[part], value);
        target[key] = key === "premiumDietOptions" ? control.value.split(",").map(item => item.trim()).filter(Boolean) : control.value;
      } else if (control.dataset.starterFeature) value.features[control.dataset.starterFeature] = control.checked;
      else if (control.dataset.starterEnabled !== undefined) value.campaigns[Number(control.dataset.starterEnabled)].enabled = control.checked;
      changed();
      container.querySelector("[data-starter-reviewed]").checked = false;
    });
    container.addEventListener("click", event => {
      const button = event.target.closest("[data-starter-action]");
      if (!button || !value) return;
      const i = Number(button.dataset.index), action = button.dataset.starterAction;
      if (action === "samples") {
        const samples = root.WSStarterSetup.fictional(fictionalId, selectedCurrency);
        // Keep customized structure and labels; only fill corresponding numeric examples.
        value.rsvp.fee = value.rsvp.extraGuestFee = value.rsvp.premiumDietFee = "0";
        value.tiers.forEach((tier, index) => { tier.minAmount = samples.tiers[index]?.minAmount || ""; });
        value.registry.forEach((item, index) => { item.target = samples.registry[index]?.target || ""; });
        if (value.vip) value.vip.price = samples.vip.price;
        value.amountPresets = samples.amountPresets;
        value.campaigns.forEach((campaign, index) => {
          campaign.goal = samples.campaigns[index]?.goal || "";
          campaign.milestones.forEach((milestone, j) => { milestone.target = samples.campaigns[index]?.milestones[j]?.target || ""; });
        });
      } else if (action === "remove-tier") value.tiers.splice(i, 1);
      else if (action === "add-tier" && value.tiers.length < 6) value.tiers.push({ name: "Your sponsor package", minAmount: "", perks: "Describe your offering." });
      else if (action === "remove-campaign") value.campaigns.splice(i, 1);
      else if (action === "add-campaign" && value.campaigns.length < 6) value.campaigns.push({ name: `Your goal ${value.campaigns.length + 1}`, purpose: "Describe your plans.", goal: "", enabled: true, milestones: [] });
      else if (action === "remove-milestone") value.campaigns[i].milestones.splice(Number(button.dataset.milestone), 1);
      else if (action === "add-milestone" && value.campaigns[i].milestones.length < 10) value.campaigns[i].milestones.push({ name: "Your milestone", target: "", description: "" });
      else if (action === "remove-registry") value.registry.splice(i, 1);
      else if (action === "add-registry" && value.registry.length < 20) value.registry.push({ name: "Your gift goal", category: "", description: "", target: "" });
      else if (action === "remove-vip") value.vip = null;
      else if (action === "add-vip") value.vip = { title: "Your seating offering", description: "", seats: "1", price: "" };
      changed();
      render();
    });
    return {
      load(next, { inspirationId = null, currency = "" } = {}) {
        value = next ? root.WSStarterSetup.clone(next) : null;
        fictionalId = inspirationId;
        selectedCurrency = currency;
        render();
      },
      currencyChanged(currency) {
        selectedCurrency = currency;
        if (value) {
          if (value.currency !== currency) {
            value = root.WSStarterSetup.clearMoney(value, currency);
            onError?.("Currency changed: all starter prices, fees and goals were cleared. Enter reviewed amounts; no conversion was made.");
          }
          changed();
          render();
        }
      },
      validate(currency) {
        if (!value) return true;
        try { root.WSStarterSetup.normalize(value, currency); return true; }
        catch (error) {
          onError?.(error.message);
          container.querySelector("[data-starter-reviewed]").focus();
          return false;
        }
      }
    };
  }
  root.WSStarterSetupEditor = { create };
})(globalThis);
