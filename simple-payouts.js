import { kesToMinor, minorToKes } from "./manual-payout-setup.js";

const reasons = { recipient_check: "Recipient details need checking", funds_review: "Balance or fees need review",
  operator_unavailable: "Waiting for an operator", outcome_uncertain: "Transfer outcome uncertain — do not resend",
  other_review: "Staff review needed" };
const labels = { requested: "Requested", reviewed: "Recipient checked; awaiting Processing", hold: "On Hold",
  processing: "Processing — one operator has claimed this transfer", paid: "Paid — operator-reported",
  cancelled: "Cancelled before processing" };
const uuid = () => {
  const key = globalThis.crypto?.randomUUID?.();
  if (!key) throw new Error("Secure request keys unavailable. Use an HTTPS browser.");
  return key;
};
async function json(api, url, body) {
  const response = await api(url, body ? { method: "POST", body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Payout service unavailable. Refresh history before retrying.");
    error.status = response.status;
    throw error;
  }
  return data;
}
function history(rows, esc, money) {
  return rows.length ? rows.map(r => `<article class="card" style="overflow-wrap:anywhere;min-width:0" data-simple-id="${esc(r.id)}">
    <h4>${esc(money(r.amount_minor, r.currency))} · ${esc(labels[r.status] || "Review required")}</h4>
    <p>Partner ${esc(r.partner_slot)} · ${esc(new Date(r.requested_at).toLocaleDateString())}
      ${r.fee_minor !== null && r.fee_minor !== undefined ? ` · transfer fee ${esc(money(r.fee_minor, r.currency))}` : " · fee confirmed by the operator before Processing"}</p>
    ${r.reason ? `<p role="status">${esc(reasons[r.reason] || "Staff review needed")}. Reservation retained.</p>` : ""}
    ${r.recipient_changed && !["paid", "cancelled"].includes(r.status) ? `<p role="alert">Identity or recipient details changed after this request. Do not send to the updated details on this claim. ${r.claimed_at ? "Hold if not already sent; only the claimed operator may report an already completed transfer to the originally checked recipient." : "Cancel before Processing and request again with the correct details."}</p>` : ""}
    ${r.transaction_reference ? `<p>Transaction ID: <strong>${esc(r.transaction_reference)}</strong>. Reported by the operator, not provider-verified or statement-reconciled.</p>` : ""}
    ${r.claimed_at && r.status !== "paid" ? "<p>Never send again, cancel or release because of a timeout. The existing operator must confirm the outcome.</p>" : ""}
    <details><summary>Status history</summary>${(r.history || []).map(e => `<p>${esc(labels[e.state] || e.state)}${e.reason ? ` · ${esc(reasons[e.reason])}` : ""}${e.system_event ? " · automatic accounting Hold (not a human action)" : ""} · ${esc(new Date(e.at).toLocaleString())}</p>`).join("")}</details>
  </article>`).join("") : "<p>No payout requests yet.</p>";
}
export async function mountCouple(el, { weddingId, api, money, esc }) {
  const url = `/api/weddings?action=simple-payout-status&weddingId=${encodeURIComponent(weddingId)}`;
  const storage = `simple-payout-request:${weddingId}`;
  const data = await json(api, url);
  let pending = JSON.parse(sessionStorage.getItem(storage) || "null");
  el.innerHTML = `<h3>Request a payout</h3>
    ${data.deficit_recorded ? '<p role="alert">A refund or dispute created a recorded payout-funding deficit. Requests and new Processing are held for review. Existing claims are not released; never resend. Paid remains the operator’s report of an actual completed transfer.</p>' : ""}
    <p>Available wedding balance: <strong data-simple-balance>${esc(money(data.available_minor, data.currency))}</strong>.
      This excludes fees, holds, expenses and existing payout reservations. It is not a bank liquidity guarantee.</p>
    <p>Request → Hold or Processing → Paid. We do not send money automatically. Paid means the operator reports sending it and records the transaction ID.</p>
    ${!data.supported ? '<p role="alert">This simple path currently supports KES/M-Pesa only. Contact support for other receiving methods. Do not enter bank details here.</p>' : ""}
    ${!data.kyc_complete ? '<p role="alert">Complete both partners’ <a href="#kyc-section">private identity details and consent</a> before requesting.</p>' : ""}
    <form data-simple-request>
      <label>Amount (KES)<input name="amount" inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?" required data-contact-allowed autocomplete="off"></label>
      <label>Send to<select name="partner" required><option value="">Choose your existing partner phone</option>
        ${(data.recipients || []).map(r => `<option value="${r.slot}">${esc(r.label)}</option>`).join("")}</select></label>
      <label><input name="confirmed" type="checkbox" required> I consent to payment to this partner’s existing phone after staff checks it. My request reserves the amount; the operator confirms any additional transfer fee before Processing.</label>
      <button type="submit"${!data.supported || !data.kyc_complete || data.deficit_recorded ? " disabled" : ""}>Request payout</button>
    </form><p data-simple-result role="status" aria-live="polite"></p>
    <h3>Your payout requests</h3><div data-simple-history>${history(data.requests || [], esc, money)}</div>`;
  const form = el.querySelector("form"), result = el.querySelector("[data-simple-result]");
  if (pending) {
    form.elements.amount.value = minorToKes(pending.amountMinor);
    form.elements.partner.value = String(pending.partner);
    form.elements.amount.readOnly = true;
    form.elements.partner.disabled = true;
    result.textContent = "A previous request needs confirmation. Retry unchanged; the same key prevents a duplicate.";
  }
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector("button");
    if (button.disabled || !form.elements.confirmed.checked) return;
    try {
      if (!pending) {
        const amountMinor = kesToMinor(form.elements.amount.value), partner = Number(form.elements.partner.value);
        if (amountMinor<=0 || ![1, 2].includes(partner)) throw new Error("Choose a positive amount and an existing partner recipient.");
        if (amountMinor>data.available_minor) throw new Error("This amount exceeds your available balance.");
        pending = { key: uuid(), amountMinor, partner, confirmed: true };
        sessionStorage.setItem(storage, JSON.stringify(pending));
      }
      button.disabled = true;
      form.elements.amount.readOnly = true;
      form.elements.partner.disabled = true;
      await json(api, `/api/weddings?action=simple-payout-request&weddingId=${encodeURIComponent(weddingId)}`, pending);
      sessionStorage.removeItem(storage);
      pending = null;
      await mountCouple(el, { weddingId, api, money, esc });
      el.querySelector("[data-simple-result]").textContent = "Payout requested. Current status and reservations are shown below; retrying never creates a second request.";
    } catch (error) {
      if (pending && error.status >= 400 && error.status < 500) {
        sessionStorage.removeItem(storage);
        pending = null;
        form.elements.amount.readOnly = false;
        form.elements.partner.disabled = false;
      }
      result.textContent = error.message + (pending ? " Retry unchanged; do not create a second request." : "");
      button.disabled = false;
    }
  };
}

export async function mountAdmin(el, { api, money, esc, role, userId }) {
  const data = await json(api, "/api/admin?action=manual-payout-simple");
  userId = data.actor_id || userId;
  el.innerHTML = `<h3>Simple manual payouts</h3>
    <p>Choose Hold or Processing. After sending once outside this site, enter the transaction ID and explicitly confirm Paid.</p>
    <p class="fine">${esc(data.notice)} Other staff need a second eligible reviewer. The protected Owner may explicitly process solo.
      Fees are entered, never assumed. Processing reserves internal exposure, not bank funds; check portal liquidity externally.</p>
    <p data-simple-result role="status" aria-live="polite"></p>
    ${(data.weddings || []).map(w => `<section><h3>${esc(w.label)}</h3>
      ${w.payouts.deficit_recorded ? `<p role="alert">Adjustment deficit recorded. Current shortfall: ${esc(money(w.payouts.deficit_minor, w.payouts.currency))}. New requests/Processing are blocked pending incident review. Existing claims/reservations remain held; do not send or resend. Record Paid only for an actual completed transfer.</p>` : ""}
      <p>Available for new requests: ${esc(money(w.payouts.available_minor, w.payouts.currency))}.
        <a href="/wedding.html?id=${encodeURIComponent(w.id)}#kyc-section">Open private recipient / identity details</a></p>
      ${history(w.payouts.requests || [], esc, money)}</section>`).join("") || "<p>No couple payout requests yet.</p>"}`;
  const rows = (data.weddings || []).flatMap(w => w.payouts.requests || []);
  for (const article of el.querySelectorAll("[data-simple-id]")) {
    const r = rows.find(row => row.id === article.dataset.simpleId);
    if (["paid", "cancelled"].includes(r.status)) continue;
    const buttons = document.createElement("div");
    buttons.className = "acts";
    buttons.innerHTML = `<button type="button" data-do="hold">Hold</button>
      ${!r.claimed_at ? '<button type="button" data-do="processing">Processing</button><button type="button" data-do="reviewed">Check recipient for another operator</button><button type="button" data-do="cancelled">Cancel before processing</button>' :
      (!userId || userId === r.sender_id ? '<button type="button" data-do="paid">Record Paid</button>' : '<p>The claimed operator must report Paid. Do not send again.</p>')}`;
    article.append(buttons);
    buttons.onclick = event => {
      const action = event.target.closest("[data-do]")?.dataset.do;
      if (!action) return;
      article.querySelector("[data-simple-action]")?.remove();
      const form = document.createElement("form");
      form.dataset.simpleAction = action;
      form.innerHTML = `<h4>${esc(action === "paid" ? "Report the completed transfer" : action === "processing" ? "Claim Processing before sending" : action === "reviewed" ? "Check recipient" : action === "cancelled" ? "Cancel and release this unclaimed reservation" : "Put this request on Hold")}</h4>
        ${action === "hold" ? `<label>Reason<select name="reason" required>${Object.entries(reasons).map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join("")}</select></label>` : ""}
        ${action === "processing" ? `<label>Expected transfer fee (KES; enter 0 only if actually free)<input name="fee" inputmode="decimal" required data-contact-allowed autocomplete="off"></label>
          ${role === "owner" ? '<label><input type="checkbox" name="solo"> I explicitly choose audited protected-Owner solo processing.</label>' : ""}` : ""}
        ${["processing", "reviewed"].includes(action) ? '<label><input type="checkbox" name="recipient" required> I checked this partner’s actual receiving phone/name against their private identity details and consent. I am not claiming provider verification.</label>' : ""}
        ${action === "paid" ? '<label>Actual transaction ID<input name="reference" required maxlength="120" pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,119}" data-contact-allowed autocomplete="off"></label>' : ""}
        <label><input name="confirmed" type="checkbox" required> ${action === "paid" ? `I personally sent exactly ${esc(money(r.amount_minor, r.currency))}, with the recorded fee, to the checked recipient and confirm this transaction ID. This is my report, not provider verification.` :
        action === "processing" ? "Create one durable claim. This site sends nothing; I will transfer once externally only under my authorization and will never blindly resend." :
        action === "hold" ? "Keep the reservation and any existing processing claim; this does not authorize another send." :
        action === "cancelled" ? "No processing claim or transfer exists. Release this request only." : "Record my recipient check, without transferring money."}</label>
        <button type="submit">${action === "paid" ? "Confirm Paid — operator-reported" : "Confirm " + (action === "reviewed" ? "recipient check" : action)}</button>
        <p data-action-result role="status"></p>`;
      article.append(form);
      form.onsubmit = async e => {
        e.preventDefault();
        const button = form.querySelector("button"), output = form.querySelector("[data-action-result]");
        if (button.disabled || !form.elements.confirmed.checked) return;
        try {
          const body = { id: r.id, action, reason: form.elements.reason?.value || null,
            fee: action === "processing" ? kesToMinor(form.elements.fee.value) : null,
            reference: action === "paid" ? form.elements.reference.value.trim().toUpperCase() : null,
            solo: form.elements.solo?.checked || false, recipient_confirmed: form.elements.recipient?.checked || false,
            confirmed: true };
          const storage = `simple-payout-action:${r.id}:${action}`;
          const pending = JSON.parse(sessionStorage.getItem(storage) || "null");
          const signature = JSON.stringify(body);
          if (pending && pending.signature !== signature && !pending.rejected) throw new Error("A prior action needs confirmation. Retry with the original values and refresh history; do not resend.");
          body.key = pending?.signature === signature ? pending.key : uuid();
          sessionStorage.setItem(storage, JSON.stringify({ key: body.key, signature }));
          button.disabled = true;
          const response = await json(api, "/api/admin?action=manual-payout-simple-action", body);
          sessionStorage.removeItem(storage);
          await mountAdmin(el, { api, money, esc, role, userId });
          el.querySelector("[data-simple-result]").textContent = response.result?.conflict ?
            "Transaction ID conflict: request on Hold, claim and reservation retained. Do not resend." :
            action === "paid" ? "Paid recorded as operator-reported, not provider-verified." : "Payout updated.";
        } catch (error) {
          if (error.status >= 400 && error.status < 500) {
            const storage = `simple-payout-action:${r.id}:${action}`;
            const pending = JSON.parse(sessionStorage.getItem(storage) || "null");
            if (pending) sessionStorage.setItem(storage, JSON.stringify({ ...pending, rejected: true }));
          }
          output.textContent = error.message;
          button.disabled = false;
        }
      };
    };
    if (r.claimed_at && r.status !== "paid") buttons.querySelector('[data-do="paid"]')?.click();
  }
}
