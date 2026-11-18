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
      if (row.send_outcome_unknown) {
        card.append(element("p", "Send start recorded; outcome is unknown. Do not retry or resend. Investigate and report any actual transfer."));
      }
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
        const current = element("button", "Check my current claimed recipient");
        current.type = "button";
        const currentDetails = element("p");
        current.addEventListener("click", async () => {
          current.disabled = true;
          try {
            const snapshot = await WSReferrals.request("manual-sender-current&id=" + encodeURIComponent(row.request_id));
            currentDetails.textContent = `Current checked destination: ${snapshot.expected_name}, ${snapshot.phone}. This is not authorization to send or resend.`;
          } catch (error) { notice.textContent = error.message; }
          finally { current.disabled = false; }
        });
        card.append(current, currentDetails);
        if (row.state === "processing" && !row.send_started) {
          const form = element("form");
          const confirm = element("input"); confirm.type = "checkbox"; confirm.required = true;
          const confirmLabel = element("label", " I checked external funding, reversals and prior transfers. A lost response means an unknown outcome; I will not retry or resend.");
          confirmLabel.prepend(confirm);
          const button = element("button", "Start one manual send"); button.type = "submit";
          const result = element("p");
          form.append(confirmLabel, button, result);
          form.addEventListener("submit", async event => {
            event.preventDefault();
            button.disabled = true;
            try {
              const start = await WSReferrals.request("manual-send-start",
                { id: row.request_id, key: crypto.randomUUID(), confirmed: confirm.checked });
              if (start.send_authorized === true) {
                result.textContent = `One-time authorization: ${start.expected_name}, ${start.phone}. No transfer was made by this site. Never reuse this response or resend.`;
              } else {
                result.textContent = "No authorization was issued. The claim remains held; do not resend.";
              }
            } catch {
              result.textContent = "Send-start outcome may be unknown. Do not retry or send; inspect the retained claim and investigate.";
            }
          });
          card.append(form);
        }
      }
      for (const incident of row.incidents || []) {
        const section = element("section");
        section.append(element("h3", `Incident ${incident.id}: ${incident.reviewed ? "investigation reviewed" : "investigation required"}`),
          element("p", "The affected claim remains held. Do not resend, even after investigation review."));
        if (!incident.reviewed) {
          const evidenceForm = element("form");
          const reference = element("input"); reference.required = true;
          const sha = element("input"); sha.required = true; sha.pattern = "[0-9a-f]{64}";
          const confirmEvidence = element("input"); confirmEvidence.type = "checkbox"; confirmEvidence.required = true;
          const evidenceLabel = element("label", " I recorded the external investigation and all related transfer evidence.");
          evidenceLabel.prepend(confirmEvidence);
          const evidenceButton = element("button", "Record investigation evidence"); evidenceButton.type = "submit";
          evidenceForm.append(labeled("External evidence reference UUID", reference), labeled("Evidence SHA-256", sha),
            evidenceLabel, evidenceButton);
          let evidenceKey = null, previousEvidence = null;
          evidenceForm.addEventListener("submit", async event => {
            event.preventDefault();
            const payload = { incident: incident.id, reference: reference.value.trim(), sha256: sha.value.trim(),
              confirmed: confirmEvidence.checked };
            const fingerprint = JSON.stringify(payload);
            if (!evidenceKey || previousEvidence !== fingerprint) { evidenceKey = crypto.randomUUID(); previousEvidence = fingerprint; }
            evidenceButton.disabled = true;
            try {
              await WSReferrals.request("manual-incident-evidence", { ...payload, key: evidenceKey });
              await load(); notice.textContent = "Investigation evidence recorded. The claim remains held.";
            } catch (error) { notice.textContent = error.message; }
            finally { evidenceButton.disabled = false; }
          });
          section.append(evidenceForm);
          if (incident.evidence.length) {
            const reviewForm = element("form");
            const evidence = element("select");
            for (const item of incident.evidence) {
              const option = element("option", `${item.id} (submitted by ${item.submitted_by}; reference ${item.external_reference}; SHA-256 ${item.sha256})`);
              option.value = item.id; evidence.append(option);
            }
            const solo = element("input"); solo.type = "checkbox";
            const soloLabel = element("label", " Owner solo investigation review"); soloLabel.prepend(solo);
            const confirmed = element("input"); confirmed.type = "checkbox"; confirmed.required = true;
            const confirmLabel = element("label", " I independently checked the evidence and accounted for related transfers and liabilities. The affected claim stays held and must not be resent.");
            confirmLabel.prepend(confirmed);
            const reviewButton = element("button", "Record investigation review"); reviewButton.type = "submit";
            reviewForm.append(labeled("Investigation evidence", evidence), soloLabel, confirmLabel, reviewButton);
            reviewForm.addEventListener("submit", async event => {
              event.preventDefault(); reviewButton.disabled = true;
              try {
                await WSReferrals.request("manual-incident-review", { incident: incident.id,
                  evidence: evidence.value, ownerSolo: solo.checked, confirmed: confirmed.checked });
                await load(); notice.textContent = "Investigation reviewed. The affected claim remains held; do not resend.";
              } catch (error) { notice.textContent = error.message; }
              finally { reviewButton.disabled = false; }
            });
            section.append(reviewForm);
          }
        }
        card.append(section);
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
