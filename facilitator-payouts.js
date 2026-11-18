(async function () {
  "use strict";
  const notice = document.getElementById("notice");
  const requests = document.getElementById("requests");
  if (!WS.token()) {
    location.replace("/signin.html?next=" + encodeURIComponent("/facilitator-payouts.html"));
    return;
  }
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  const labeled = (text, control) => {
    const label = element("label", text);
    label.append(control);
    return label;
  };
  async function load() {
    const rows = await WSReferrals.request("manual-staff-workspace");
    requests.replaceChildren();
    if (!rows.length) requests.append(element("p", "No requests."));
    for (const row of rows) {
      const card = element("section");
      card.className = "card";
      card.append(element("h2", `${WSReferrals.money(row.amount_minor, row.currency)} — ${row.state}`));
      card.append(element("p", `Request ${row.request_id}. ${row.do_not_resend ? "Claimed: do not resend." : "Not claimed."}`));
      if (row.operator_reported) card.append(element("p", "Operator reported a transfer; external transfer is not verified."));
      if (row.do_not_resend) {
        const reveal = element("button", "Reveal my claimed recipient");
        reveal.type = "button";
        const details = element("p");
        reveal.addEventListener("click", async () => {
          reveal.disabled = true;
          try {
            const snapshot = await WSReferrals.request("manual-sender-snapshot&id=" + encodeURIComponent(row.request_id));
            details.textContent = `Historical claimed destination: ${snapshot.expected_name}, ${snapshot.phone}. This is not authorization to send or resend.`;
          } catch (error) { notice.textContent = error.message; }
          finally { reveal.disabled = false; }
        });
        card.append(reveal, details);
      }
      if (!["paid", "cancelled", "outcome_review_required"].includes(row.state)) {
        const form = element("form");
        const select = element("select");
        const options = row.do_not_resend ? ["hold", "paid"] : ["reviewed", "processing", "hold", "cancelled"];
        for (const action of options) {
          const option = element("option", action);
          option.value = action;
          select.append(option);
        }
        const fee = element("input");
        fee.type = "number"; fee.min = "0"; fee.step = "1"; fee.placeholder = "Fee in minor units (review / claim)";
        const reason = element("select");
        for (const value of ["recipient_check", "funds_review", "operator_unavailable", "outcome_uncertain", "other_review"]) {
          const option = element("option", value.replaceAll("_", " ")); option.value = value; reason.append(option);
        }
        const reference = element("input");
        reference.placeholder = "Actual transfer reference (paid report only)";
        const solo = element("input"); solo.type = "checkbox";
        const soloLabel = element("label", " Owner solo claim (Owner only)"); soloLabel.prepend(solo);
        const confirm = element("input"); confirm.type = "checkbox"; confirm.required = true;
        const confirmLabel = element("label", " I checked the action, external funding, reversals and prior transfers; this does not send money.");
        confirmLabel.prepend(confirm);
        const button = element("button", "Record action"); button.type = "submit";
        form.append(labeled("Action", select), labeled("Fee in minor units (review / claim)", fee),
          labeled("Hold reason", reason), labeled("Transfer reference (paid report only)", reference),
          soloLabel, confirmLabel, button);
        let key = null, previous = null;
        form.addEventListener("submit", async event => {
          event.preventDefault();
          const action = select.value;
          const amount = fee.value === "" ? null : Number(fee.value);
          const payload = { id: row.request_id, action, fee: ["reviewed", "processing"].includes(action) ? amount : null,
            reason: action === "hold" ? reason.value : null, reference: action === "paid" ? reference.value.trim() : null,
            ownerSolo: action === "processing" && solo.checked, confirmed: confirm.checked };
          if (["reviewed", "processing"].includes(action) && (!Number.isSafeInteger(amount) || amount < 0)) {
            notice.textContent = "Enter the explicit nonnegative fee in minor units."; return;
          }
          if (action === "paid" && !payload.reference) { notice.textContent = "Enter the actual transfer reference."; return; }
          if (!key || previous !== JSON.stringify(payload)) { key = crypto.randomUUID(); previous = JSON.stringify(payload); }
          button.disabled = true;
          try {
            const result = await WSReferrals.request("manual-staff-action", { ...payload, key });
            notice.textContent = result.conflict ? "Conflicting outcome recorded. Do not resend." :
              result.replayed ? "Historical action acknowledged. This is not permission to resend." : "Action recorded. No transfer was made by this site.";
            await load();
          } catch (error) { notice.textContent = error.message; }
          finally { button.disabled = false; }
        });
        card.append(form);
      }
      requests.append(card);
    }
  }
  try { await load(); } catch (error) { notice.textContent = error.message; }
})();
