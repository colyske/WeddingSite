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
      ${r.processing_fee_minor !== null && r.processing_fee_minor !== undefined ?
        ` · customer processing fee ${esc(money(r.processing_fee_minor, r.currency))} · total debit ${esc(money(r.amount_minor+r.processing_fee_minor, r.currency))} (fixed at request)` :
        r.fee_minor !== null && r.fee_minor !== undefined ? ` · historical transfer fee ${esc(money(r.fee_minor, r.currency))}` : " · historical fee contract; checked before Processing"}</p>
    ${recipientDetail(r, esc, money)}
    ${r.reason ? `<p role="status">${esc(reasons[r.reason] || "Staff review needed")}. Reservation retained.</p>` : ""}
    ${r.recipient_outcome_held ? '<p role="alert">Hold — do not resend or mark Paid. Recipient/transfer outcome is uncertain. Request reversal through the official M-Pesa/provider support channel. This site cannot reverse a transfer; the claim and reservation remain retained.</p>' : ""}
    ${r.recipient_changed && !["paid", "cancelled"].includes(r.status) ? `<p role="alert">Identity or recipient details changed after this request. Do not send to the updated details on this claim. ${r.claimed_at ? "Hold if not already sent; only the claimed operator may report an already completed transfer to the originally checked recipient." : "Cancel before Processing and request again with the correct details."}</p>` : ""}
    ${r.transaction_reference ? `<p>Transaction ID: <strong>${esc(r.transaction_reference)}</strong>. Reported by the operator, not provider-verified or statement-reconciled.</p>` : ""}
    ${r.claimed_at && r.status !== "paid" ? "<p>Never send again, cancel or release because of a timeout. The existing operator must confirm the outcome.</p>" : ""}
    <details><summary>Status history</summary>${(r.history || []).map(e => `<p>${esc(labels[e.state] || e.state)}${e.reason ? ` · ${esc(reasons[e.reason])}` : ""}${e.system_event ? " · automatic accounting Hold (not a human action)" : ""} · ${esc(new Date(e.at).toLocaleString())}</p>`).join("")}</details>
  </article>`).join("") : "<p>No payout requests yet.</p>";
}
function recipientDetail(r, esc, money) {
  return r.recipient?.expected_name && r.recipient?.phone ?
    `<p data-recipient-detail>Amount recipient receives: <strong>${esc(money(r.amount_minor, r.currency))}</strong>.
      Expected recipient name: <strong>${esc(r.recipient.expected_name)}</strong>.
      Destination M-Pesa phone: <strong>${esc(r.recipient.phone)}</strong>.
      ${r.recipient.source === "unchanged_legacy_kyc" ? "Original details proven by unchanged request KYC hash." : "Immutable request recipient snapshot."}
      Expected name is supplied identity information, not provider-verified identity.</p>` :
    '<p data-recipient-detail role="alert">Original recipient name/phone cannot be established. Do not send or mark Paid. Hold any existing claim; do not resend. An unclaimed request may be cancelled and requested again with confirmed details.</p>';
}
export function balanceDetail(data, money) {
  const amount = value => value === undefined || value === null ? "Unavailable" : money(value, data.currency);
  const date = data.next_time_release_at ? new Date(data.next_time_release_at).toLocaleString() : "None scheduled";
  return (data.provider_costs_company_overhead ?
    `Provider costs are company overhead, not deductions or unknown-fee holds on your balance. Customer withdrawal processing fee: ${amount(data.withdrawal_processing_fee_minor)}. ` :
    `Awaiting actual payment fees: ${amount(data.fee_pending_minor)}. `) +
    `Time hold: ${amount(data.time_held_minor)}; next stored release date: ${date}. ` +
    `Refund/dispute/expense and legacy obligations: ${amount(data.obligations_minor)}. Payout commitments (including paid and active reservations): ${amount(data.payout_committed_minor)}. ` +
    (data.provider_costs_company_overhead ? `Customer fees on operator-reported Paid payouts: ${amount(data.withdrawal_processing_revenue_minor)}; reserved, not earned: ${amount(data.withdrawal_processing_reserved_minor)}. These are customer charges, not actual provider costs or provider-verified revenue. ` : "") +
    `Fee and time holds may overlap; do not add these figures. Configured time hold for new confirmed payments: ${data.configured_hold_days ?? "Unavailable"} day(s). ` +
    `Minimum received per payout: ${amount(data.min_payout_minor)}; a below-minimum amount is allowed only when amount plus processing fee drains the full remaining balance. ` +
    `A release date or zero-day setting is not settlement proof or guaranteed portal liquidity.`;
}
function updateCoupleBalance(el, data, money) {
  el.querySelector("[data-simple-balance]").textContent = money(data.available_minor, data.currency);
  el.querySelector("[data-simple-balance-detail]").textContent = balanceDetail(data, money);
  el.querySelector("[data-simple-deficit]").textContent = data.deficit_recorded ?
    "A refund or dispute created a recorded payout-funding deficit. Requests and new Processing are held for review. Existing claims are not released; never resend." : "";
  const legacy = el.closest("#withdrawals-section");
  if (legacy) {
    legacy.querySelector("#balance-display").textContent = money(data.available_minor, data.currency);
    legacy.querySelector("#settling-display").textContent = money(data.time_held_minor, data.currency);
    legacy.querySelector("#held-display").textContent = money(data.withdrawal_processing_fee_minor ?? 0, data.currency);
    legacy.querySelector("#payout-availability-detail").textContent = balanceDetail(data, money);
  }
}
export async function mountCouple(el, { weddingId, api, money, esc }) {
  const url = `/api/weddings?action=simple-payout-status&weddingId=${encodeURIComponent(weddingId)}`;
  const storage = `simple-payout-request:${weddingId}`;
  let data = await json(api, url);
  let pending = JSON.parse(sessionStorage.getItem(storage) || "null");
  el.innerHTML = `<h3>Request a payout</h3>
    <p data-simple-deficit role="alert"></p>
    <p>Available wedding balance: <strong data-simple-balance>${esc(money(data.available_minor, data.currency))}</strong>.
      This deducts platform commission, time holds, true couple obligations and payout reservations, not company provider costs. It is not a bank liquidity guarantee.</p>
    <p data-simple-balance-detail></p><button type="button" data-refresh-balance>Refresh balance (keep form)</button>
    <p>Request → Hold or Processing → Paid. We do not send money automatically. Paid means the operator reports sending it and records the transaction ID.</p>
    ${!data.supported ? '<p role="alert">This simple path currently supports KES/M-Pesa only. Contact support for other receiving methods. Do not enter bank details here.</p>' : ""}
    ${!data.kyc_complete ? '<p role="alert">Complete both partners’ <a href="#kyc-section">private identity details and consent</a> before requesting.</p>' : ""}
    <form data-simple-request>
      <label>Amount you receive (KES)<input name="amount" inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?" required data-contact-allowed autocomplete="off"></label>
      <button type="button" data-drain-balance>Use full remaining balance after processing fee</button>
      <p data-withdrawal-quote></p>
      <label>Send to<select name="partner" required><option value="">Choose your existing partner phone</option>
        ${(data.recipients || []).map(r => `<option value="${r.slot}">${esc(r.expected_name || r.label)} — ${esc(r.phone || "Phone unavailable")}</option>`).join("")}</select></label>
      <p data-selected-recipient></p>
      <label><input name="confirmed" type="checkbox" required> I confirm the displayed expected recipient name and full M-Pesa phone, amount I receive, customer processing fee and total balance debit, and consent to this destination. The fee is fixed at my request; no additional customer fee is added at Processing.</label>
      <button type="submit"${!data.supported || !data.kyc_complete || data.deficit_recorded ? " disabled" : ""}>Request payout</button>
    </form><p data-simple-result role="status" aria-live="polite"></p>
    <h3>Your payout requests</h3><div data-simple-history>${history(data.requests || [], esc, money)}</div>`;
  const form = el.querySelector("form"), result = el.querySelector("[data-simple-result]");
  const submit = form.querySelector('button[type="submit"]');
  const updateRecipient = () => {
    const r = data.recipients?.find(r => r.slot === Number(form.elements.partner.value));
    const stale = pending && pending.recipientHash !== data.recipient_hash;
    el.querySelector("[data-selected-recipient]").textContent = stale ?
      "The recipient version changed after your pending request. Never substitute edited details. Retry the original request unchanged to establish its outcome; a new request requires refreshed consent." :
      r?.expected_name && r?.phone ? `Expected recipient: ${r.expected_name}. Destination M-Pesa phone: ${r.phone}. This name is not provider-verified.` :
      "Select a recipient with an established expected name and full phone.";
  };
  const updateQuote = () => {
    const fee = pending?.processingFeeMinor ?? data.withdrawal_processing_fee_minor ?? 0;
    let amount;
    try { amount = kesToMinor(form.elements.amount.value); } catch { amount = null; }
    el.querySelector("[data-withdrawal-quote]").textContent =
      `You receive: ${amount === null ? "Enter an amount" : money(amount, data.currency)}. Customer processing fee: ${money(fee, data.currency)}. ` +
      `Total balance debit: ${amount === null ? "Enter an amount" : money(amount+fee, data.currency)}. Provider costs are company overhead.`;
  };
  form.elements.amount.oninput = () => { form.elements.confirmed.checked = false; updateQuote(); };
  form.elements.partner.onchange = () => { form.elements.confirmed.checked = false; updateRecipient(); };
  el.querySelector("[data-drain-balance]").onclick = () => {
    if (pending) return;
    const amount = data.available_minor-(data.withdrawal_processing_fee_minor ?? 0);
    if (amount<=0) { result.textContent = "Available funds cannot cover the processing fee and a positive payout."; return; }
    form.elements.amount.value = minorToKes(amount);
    form.elements.confirmed.checked = false;
    updateQuote();
  };
  updateCoupleBalance(el, data, money);
  el.querySelector("[data-refresh-balance]").onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const fresh = await json(api, url);
      if (!pending && (data.policy_revision !== fresh.policy_revision ||
        data.withdrawal_processing_fee_minor !== fresh.withdrawal_processing_fee_minor ||
        data.recipient_hash !== fresh.recipient_hash)) form.elements.confirmed.checked = false;
      data = fresh;
      const selected = form.elements.partner.value;
      form.elements.partner.innerHTML = '<option value="">Choose your existing partner phone</option>' +
        (data.recipients || []).map(r => `<option value="${r.slot}">${esc(r.expected_name || r.label)} — ${esc(r.phone || "Phone unavailable")}</option>`).join("");
      form.elements.partner.value = selected;
      updateRecipient();
      updateCoupleBalance(el, data, money);
      updateQuote();
      updateRecipient();
      submit.disabled = !data.supported || !data.kyc_complete || data.deficit_recorded;
      result.textContent = "Balance refreshed. Your typed request is unchanged; fees and holds still apply.";
    } catch (error) { result.textContent = "Balance refresh failed: " + error.message; }
    finally { button.disabled = false; }
  };
  if (pending) {
    form.elements.amount.value = minorToKes(pending.amountMinor);
    form.elements.partner.value = String(pending.partner);
    form.elements.amount.readOnly = true;
    form.elements.partner.disabled = true;
    result.textContent = "A previous request needs confirmation. Retry unchanged; the same key prevents a duplicate.";
  }
  updateQuote();
  form.onsubmit = async event => {
    event.preventDefault();
    const button = submit;
    if (button.disabled || !form.elements.confirmed.checked) return;
    try {
      if (!pending) {
        const amountMinor = kesToMinor(form.elements.amount.value), partner = Number(form.elements.partner.value);
        if (amountMinor<=0 || ![1, 2].includes(partner)) throw new Error("Choose a positive amount and an existing partner recipient.");
        const recipient = data.recipients?.find(r => r.slot === partner);
        if (!recipient?.expected_name || !recipient?.phone || !data.recipient_hash)
          throw new Error("Refresh recipient details before confirming the expected name and phone.");
        const processingFeeMinor = data.withdrawal_processing_fee_minor ?? 0;
        const total = amountMinor+processingFeeMinor;
        if (!Number.isSafeInteger(total) || total>data.available_minor) throw new Error("Amount plus processing fee exceeds your available balance.");
        if (amountMinor<(data.min_payout_minor ?? 0) && total!==data.available_minor)
          throw new Error("A below-minimum amount must drain the full remaining balance including the processing fee.");
        if (data.max_payout_minor !== undefined && amountMinor>data.max_payout_minor) throw new Error("Amount exceeds the configured maximum payout.");
        pending = { key: uuid(), amountMinor, partner, confirmed: true, recipientHash: data.recipient_hash,
          ...(Number.isSafeInteger(data.policy_revision) ? { processingFeeMinor, policyRevision: data.policy_revision } : {}) };
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
        form.elements.confirmed.checked = false;
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
    <button type="button" data-refresh-balances>Refresh balances (keep transaction form)</button>
    <p>Choose Hold or Processing. After sending once outside this site, enter the transaction ID and explicitly confirm Paid.</p>
    <p class="fine">${esc(data.notice)} Other staff need a second eligible reviewer. The protected Owner may explicitly process solo.
      New customer processing fees are already fixed and reserved at couple submission; company provider costs never reprice them.
      Historical contracts retain their recorded obligations. Processing is internal exposure, not bank funds; check portal liquidity externally.</p>
    <p data-simple-result role="status" aria-live="polite"></p>
    ${(data.weddings || []).map(w => `<section data-balance-wedding="${esc(w.id)}"><h3>${esc(w.label)}</h3>
      <p data-balance-deficit role="alert">${w.payouts.deficit_recorded ? `Adjustment deficit recorded. Current shortfall: ${esc(money(w.payouts.deficit_minor, w.payouts.currency))}. New requests/Processing are blocked pending incident review. Existing claims/reservations remain held; do not send or resend. Record Paid only for an actual completed transfer.` : ""}</p>
      <p>Available for new requests: <strong data-balance-amount>${esc(money(w.payouts.available_minor, w.payouts.currency))}</strong>.
        <a href="/wedding.html?id=${encodeURIComponent(w.id)}#kyc-section">Open private recipient / identity details</a></p>
      <p data-balance-detail>${esc(balanceDetail(w.payouts, money))}</p>
      ${history(w.payouts.requests || [], esc, money)}</section>`).join("") || "<p>No couple payout requests yet.</p>"}`;
  el.querySelector("[data-refresh-balances]").onclick = async event => {
    const button = event.currentTarget, result = el.querySelector("[data-simple-result]");
    button.disabled = true;
    try {
      const fresh = await json(api, "/api/admin?action=manual-payout-simple");
      for (const section of el.querySelectorAll("[data-balance-wedding]")) {
        const w = fresh.weddings.find(w => w.id === section.dataset.balanceWedding);
        if (!w) throw new Error("Request history changed. Preserve your transaction ID and reload before deciding.");
        section.querySelector("[data-balance-amount]").textContent = money(w.payouts.available_minor, w.payouts.currency);
        section.querySelector("[data-balance-detail]").textContent = balanceDetail(w.payouts, money);
        section.querySelector("[data-balance-deficit]").textContent = w.payouts.deficit_recorded ?
          "Adjustment deficit recorded. Do not send or resend. Claims remain held; report Paid only for an actual completed transfer." : "";
      }

      result.textContent = "Balances refreshed. Typed transaction IDs and confirmations are unchanged. Status/actions are checked again by the server; refresh does not authorize a transfer.";
    } catch (error) { result.textContent = "Balance refresh failed: " + error.message; }
    finally { button.disabled = false; }
  };
  const rows = (data.weddings || []).flatMap(w => w.payouts.requests || []);
  for (const article of el.querySelectorAll("[data-simple-id]")) {
    const r = rows.find(row => row.id === article.dataset.simpleId);
    if (["paid", "cancelled"].includes(r.status)) continue;
    const buttons = document.createElement("div");
    buttons.className = "acts";
    buttons.innerHTML = `<button type="button" data-do="hold">Hold</button>
      ${!r.claimed_at ? `<button type="button" data-do="processing"${!r.recipient || r.recipient_changed || r.recipient_outcome_held ? " disabled" : ""}>Processing</button><button type="button" data-do="reviewed"${!r.recipient || r.recipient_changed || r.recipient_outcome_held ? " disabled" : ""}>Check recipient for another operator</button><button type="button" data-do="cancelled">Cancel before processing</button>` :
      (!userId || userId === r.sender_id ? `<button type="button" data-do="paid"${!r.recipient || r.recipient_outcome_held ? " disabled" : ""}>Record Paid</button><button type="button" data-do="uncertain">Recipient mismatch / uncertain transfer — Hold</button>` : '<p>The claimed operator must report Paid. Do not send again.</p>')}`;
    article.append(buttons);
    buttons.onclick = event => {
      const target = event.target.closest("[data-do]");
      if (!target || target.disabled) return;
      const uncertain = target.dataset.do === "uncertain";
      const action = uncertain ? "hold" : target.dataset.do;
      article.querySelector("[data-simple-action]")?.remove();
      const form = document.createElement("form");
      form.dataset.simpleAction = action;
      form.innerHTML = `<h4>${esc(action === "paid" ? "Report the completed transfer" : action === "processing" ? "Claim Processing before sending" : action === "reviewed" ? "Check recipient" : action === "cancelled" ? "Cancel and release this unclaimed reservation" : "Put this request on Hold")}</h4>
        ${["processing", "reviewed", "paid"].includes(action) ? recipientDetail(r, esc, money) : ""}
        ${action === "hold" ? `<label>Reason<select name="reason" required${uncertain ? " disabled" : ""}>${Object.entries(reasons).map(([v, label]) => `<option value="${v}"${uncertain && v === "outcome_uncertain" ? " selected" : ""}>${esc(label)}</option>`).join("")}</select></label>
          <p>For a recipient mismatch or uncertain completed transfer, choose transfer outcome uncertain. Do not resend. Request reversal through the official M-Pesa/provider support channel. This retains the claim and reservation and blocks Paid; it does not reverse money.</p>` : ""}
        ${action === "processing" ? `${r.processing_fee_minor === null || r.processing_fee_minor === undefined ?
          '<label>Historical contract: actual expected transfer fee (KES; enter 0 only if actually free)<input name="fee" inputmode="decimal" required data-contact-allowed autocomplete="off"></label>' :
          `<p>Customer processing fee ${esc(money(r.processing_fee_minor,r.currency))} was fixed at submission. Do not enter or add a provider cost; unknown company costs remain unknown.</p>`}
          ${role === "owner" ? '<label><input type="checkbox" name="solo"> I explicitly choose audited protected-Owner solo processing.</label>' : ""}` : ""}
        ${["processing", "reviewed"].includes(action) ? '<label><input type="checkbox" name="recipient" required> I checked this partner’s actual receiving phone/name against their private identity details and consent. I am not claiming provider verification.</label>' : ""}
        ${action === "paid" ? '<label>Actual transaction ID<input name="reference" required maxlength="120" pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,119}" data-contact-allowed autocomplete="off"></label><label><input type="checkbox" name="recipient" required> I compared the actual transaction recipient name and destination phone against the expected name and full M-Pesa phone displayed above; both match. This is my manual confirmation, not automated/provider identity verification.</label><p>If the name differs or you are unsure, do not confirm Paid. Choose Recipient mismatch / uncertain transfer — Hold and request reversal through the official provider. Never resend.</p>' : ""}
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
        if (button.disabled || !form.elements.confirmed.checked ||
          (["paid", "processing", "reviewed"].includes(action) && !form.elements.recipient?.checked)) return;
        try {
          const body = { id: r.id, action, reason: form.elements.reason?.value || null,
            fee: action === "processing" && (r.processing_fee_minor === null || r.processing_fee_minor === undefined) ? kesToMinor(form.elements.fee.value) : null,
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
