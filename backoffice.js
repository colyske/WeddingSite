// Shared back-office UI for admin.html and owner.html. All data comes from /api/admin (role-checked server-side).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => WS.esc(s);
  const SEC = { overview: "Overview", operations: "Operations", weddings: "Weddings", users: "Users & roles", fees: "Fees & settings", referrals: "Client referrals", ledger: "Ledger", payouts: "Payouts", b2c: "M-Pesa B2C", audit: "Audit log", security: "Security" };
  let role = "";
  let cache = {};
  let manualSetup;

  const toast = (text, bad) => {
    const el = $("notice");
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "notice" + (bad ? " bad" : " good");
    if (text) setTimeout(() => { el.hidden = true; }, 6000);
  };

  async function get(action, extra = "") {
    const res = await WS.api("/api/admin?action=" + action + extra);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }
  async function post(action, body) {
    const res = await WS.api("/api/admin?action=" + action, { method: "POST", body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  const moneyMap = (obj) => {
    const keys = Object.keys(obj || {});
    return keys.length ? keys.map(c => {
      const original = WS.money(Number(obj[c]), c, false);
      const fx = window.WeddingSiteFX;
      const usd = fx?.convertBetween(Number(obj[c]) / 100, c, "USD");
      const kes = fx?.convertBetween(Number(obj[c]) / 100, c, "KES");
      if (usd == null || kes == null) return `${original} [USD/KES conversion unavailable or stale]`;
      return `${original} [≈ ${WS.money(usd * 100, "USD", false)} / ${WS.money(kes * 100, "KES", false)}]`;
    }).join(" · ") : "USD 0.00 / KES 0.00";
  };
  const date = (v) => (v ? new Date(v).toLocaleString() : "-");
  const stat = (label, value) => `<div class="stat-card"><h3>${esc(label)}</h3><div class="number">${value}</div></div>`;
  const table = (head, rows) =>
    rows.length
      ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
      : '<p class="empty">Nothing here yet.</p>';
  const btn = (label, attrs) => `<button type="button" class="mini" ${attrs}>${esc(label)}</button>`;
  const manualFields = {
    "shared-account": ["account", "currency", "evidence"],
    "attribute-settlement": ["contribution", "custody", "line", "settled", "at", "evidence"],
    "verify-transfer": ["id", "reference", "actual", "fee", "currency", "at", "debit_evidence", "evidence"],
    "review-intent": ["id", "decision", "key", "custody", "recipient", "fee", "owner_solo"],
    evidence: ["kind", "reference", "sha256"], check: ["id", "owner_solo"], recipient: ["wedding", "evidence", "provider", "currency"],
    account: ["account", "provider", "registry", "evidence"],
    custody: ["provider", "account", "currency", "available", "statement_at", "evidence", "held"],
    statement: ["custody", "previous", "statement", "at", "opening", "credit", "debit", "closing", "held", "evidence"],
    source: ["kind", "source", "custody", "batch", "evidence", "line", "at"],
    debit: ["batch", "line", "reference", "actual", "fee", "currency", "at", "evidence"],
    settlement: ["contribution", "custody", "line", "settled", "evidence", "batch", "at"],
    request: ["key", "wedding", "custody", "recipient", "amount", "fee", "currency", "owner_solo"],
    transition: ["id", "action", "key", "evidence"],
    receipt: ["id", "reference", "actual", "fee", "currency", "at", "evidence"],
    reconcile: ["id", "provider", "account", "statement", "line", "reference", "actual", "fee", "currency", "at", "evidence"]
  };
  const manualNumbers = new Set(["available", "settled", "amount", "actual", "fee", "held", "opening", "credit", "debit", "closing"]);
  // Generated once per render so a retried submission replays the same idempotency/claim key.
  const newKey = () => globalThis.crypto?.randomUUID?.() || "";
  const manualKeys = new Map();
  const manualKey = context => {
    if (!manualKeys.has(context)) manualKeys.set(context, newKey());
    return manualKeys.get(context);
  };
  let manualResult = "";
  function manualForms(admissionEnabled) {
    const titles = { evidence: "Register real evidence", check: "Check saved evidence", account: "Register merchant account",
      "shared-account": "Prepare shared account attribution", "attribute-settlement": "Record contribution settlement proof",
      "verify-transfer": "Verify the exact completed transfer", recipient: "Prepare verified recipient revision",
      request: "Create a staff-reviewed payout request", "review-intent": "Review a couple request",
      transition: "Record the selected workflow step", receipt: "Report an actual transfer receipt" };
    return Object.entries(manualFields).map(([action, fields]) => `<details data-manual-panel="${action}"><summary>Manual-only: ${esc(titles[action] || action)}</summary>
      <form data-manual-action="${action}" data-key-context="${action}"><fieldset${action === "request" && !admissionEnabled ? " disabled" : ""}><legend>${action === "request" ? "Current reviewed manual admission required" : "Evidence preparation / existing-outcome accounting; never sends money"}</legend>
      ${fields.map(field => {
        if (field === "owner_solo") return role === "owner" ?
          '<label><input name="owner_solo" type="checkbox"> Explicit protected-Owner solo manual mode (audited; all evidence and custody controls still apply)</label>' :
          '<input name="owner_solo" type="hidden" value="">';
        const options = field === "kind" ? action === "source" ? ["payout", "expense", "adjustment"] :
          ["account", "commitment", "statement", "recipient", "custody", "settlement", "receipt", "reconciliation", "no_transfer", ...(role === "owner" ? ["policy"] : [])] :
          field === "decision" ? ["created", "declined"] :
          field === "action" ? ["approved", "executing", "cancelled", "uncertain", "resolution_proposed", "not_transferred"] : null;
        const optional = (action === "transition" && ["key", "evidence"].includes(field)) ||
          action === "review-intent" && ["key", "custody", "recipient", "fee"].includes(field) ||
          (action === "source" && ["batch", "line", "at"].includes(field)) || (action === "settlement" && field === "batch");
        const label = `${field.replaceAll("_", " ")}${manualNumbers.has(field) ? " (minor units; explicit, no defaults)" :
          ["at", "statement_at"].includes(field) ? " (UTC ISO timestamp)" : field === "sha256" ? " (evidence digest)" :
          field === "key" ? " (generated; reused if you retry this form)" : ""}`;
        return `<label>${esc(label)}${options ? `<select name="${field}">${options.map(o => `<option${action === "transition" && !admissionEnabled && ["approved", "executing"].includes(o) ? " disabled" : ""}>${o}</option>`).join("")}</select>` :
          `<input name="${field}" type="${manualNumbers.has(field) ? "number" : "text"}"${optional ? "" : " required"}${field === "key" ? ` value="${esc(manualKey(action))}"` : ""} data-contact-allowed autocomplete="off">`}</label>`;
      }).join("")}
      <label><input name="confirmed" type="checkbox" required> I reviewed immutable evidence and understand this never sends money. A claim replay is not permission to resend.</label>
      <button type="submit">${esc(titles[action] || `Record manual ${action}`)}</button></fieldset></form></details>`).join("");
  }
  function manualPolicyForm(readiness) {
            if (role !== "owner" || !readiness?.policy) return "";
            const policy = readiness.policy;
            const fields = ["custody_id", "recipient_ids", "per_payout_minor", "daily_minor", "payout_fee_minor", "fee_payer",
              "statement_max_age_minutes", "review_evidence", "fee_evidence", "rail_evidence", "secure_evidence"];
            return `<section id="manual-policy"><h4>Protected Owner manual policy</h4>
              <p>One registered account scope/currency and exact recipient revisions. Shared scopes track WeddingSite attribution, not global bank liquidity. Limits include principal plus fee.
              Fee payer must explicitly be "wedding": the shared ledger reserves/deducts the fee from wedding entitlement. Other fee payers are not supported.
              UTC-day exposure also counts prior-day open commitments and the other channel. No operational value is assumed.</p>
              <form data-manual-policy="draft" data-revision="${esc(policy.revision)}">
              ${fields.map(field => `<label>${esc(field.replaceAll("_", " "))}${field === "recipient_ids" ? " (comma-separated revision UUIDs)" : ""}
                <input name="${field}" type="${["per_payout_minor", "daily_minor", "payout_fee_minor", "statement_max_age_minutes"].includes(field) ? "number" : "text"}"
                value="${esc(Array.isArray(policy[field]) ? policy[field].join(",") : policy[field] ?? "")}"
                data-contact-allowed autocomplete="off"></label>`).join("")}
              <label><input name="confirmed" type="checkbox" required> I reviewed scoped policy, fees, funded account entitlement and secure evidence procedures. Saving appends an OFF revision and invalidates unclaimed approvals.</label>
              <button type="submit">Save reviewed draft (OFF)</button></form>
              <form data-manual-policy="activate" data-revision="${esc(policy.revision)}">
                <label><input name="confirmed" type="checkbox" required> Separately authorized: enable manual admission for this exact reviewed revision only. This never initiates a transfer or enables B2C.</label>
                <button type="submit"${readiness.blockers?.length ? " disabled" : ""}>Enable reviewed manual admission</button></form>
              <form data-manual-policy="deactivate" data-revision="${esc(policy.revision)}">
                <label><input name="confirmed" type="checkbox" required> Stop new requests/approvals/execution claims, preserving all reservations, evidence and existing-outcome accounting.</label>
                <button type="submit">Disable manual admission</button></form>
              <details><summary>Append-only policy revisions</summary>${(readiness.history || []).map(p =>
                `<p>${esc(p.revision)}: ${p.enabled ? "admission configured" : "OFF"}, actor ${esc(p.actor_id || "deployment baseline")}, ${date(p.recorded_at)}</p>`).join("")}</details>
              </section>`;
  }
  const prefill = (label, action, values) => btn(label, `data-manual-prefill="${esc(JSON.stringify({ action, values }))}"`);
  const shortId = id => id ? `<code title="${esc(id)}">${esc(id)}</code>` : "-";
  // Workflow guidance only: every RPC still enforces role, independence, policy, evidence and funds.
  function manualNextStep(r, w) {
    const id = r.id, ws = (w.requests || []).find(x => x.id === id) || {};
    if (ws.automatic || ws.claim?.channel === "automatic_b2c") return ["Automatic-channel record: read-only here. Use the separately controlled B2C workflow; no manual action is offered."];
    const debit = ws.receipt && (w.unreconciledDebits || []).find(d => d.custody_id === ws.custody_id &&
      d.transaction_reference === ws.receipt.transaction_reference);
    const reviewer = r.owner_solo ? "the same protected Owner (explicit solo mode)" : "a different eligible leader";
    const proposed = (r.events || []).find(e => e.state === "resolution_proposed");
    switch (r.state) {
      case "requested": return [`Next: approval by ${reviewer}. Approval rechecks policy, recipient and ${(w.sharedScopes || []).includes(ws.custody_id) ? "attributable settled wedding net, obligations and internal exposure" : "legacy statement-backed funds"}.`,
        prefill("Prepare approval", "transition", { id, action: "approved" }), prefill("Prepare cancellation", "transition", { id, action: "cancelled" })];
      case "approved": return [`Next: execution claim by ${r.owner_solo ? "the protected Owner" : "a sender other than the approver"} BEFORE any transfer. The authorized operator checks portal liquidity externally; WeddingSite does not reserve bank funds. Transfer only once outside this site, under separate payment authorization.`,
        prefill("Prepare execution claim", "transition", { id, action: "executing" }), prefill("Prepare cancellation", "transition", { id, action: "cancelled" })];
      case "executing": case "uncertain": return [`Claimed${ws.claim ? ` by ${esc(ws.claim.sender_id)} at ${date(ws.claim.claimed_at)}` : ""}. Never resend. Record receipt evidence, check it, then report the portal receipt; if the outcome is unknown, the sender marks it uncertain.`,
        prefill("Prepare receipt report", "receipt", { id }), ...(r.state === "executing" ? [prefill("Prepare uncertain", "transition", { id, action: "uncertain" })] : []),
        prefill("Prepare no-transfer proposal", "transition", { id, action: "resolution_proposed" })];
      case "resolution_proposed": return [`Next: ${r.owner_solo ? "protected Owner" : "independent"} confirmation that no transfer occurred, using the same checked no_transfer evidence. Funds stay held until then.`,
        prefill("Prepare not-transferred confirmation", "transition", { id, action: "not_transferred", evidence: proposed?.evidence_id || "" })];
      case "reported": if ((w.sharedScopes || []).includes(ws.custody_id)) return [
        `Receipt reported, not paid. Have ${r.owner_solo ? "the same protected Owner (explicit solo)" : "an independent leader"} check transaction-specific debit evidence from the official portal against the verified recipient, account, reference, amount, fee, currency and booked time. No whole-account statement or global balance is needed.`,
        prefill("Prepare exact transfer verification", "verify-transfer", { id, reference: ws.receipt?.transaction_reference || "",
          actual: ws.receipt?.actual_minor ?? "", fee: ws.receipt?.actual_fee_minor ?? "", currency: ws.receipt?.currency || "" })];
        return [`Receipt ${esc(ws.receipt?.transaction_reference || "")} reported. Next: append the checked statement, register its actual debit line (exact reference/amount/fee/currency/date), then ${r.owner_solo ? "the protected Owner" : "a leader other than the sender"} reconciles with checked reconciliation evidence. Only reconciliation marks paid.`,
        ...(debit ? [] : [prefill("Prepare statement debit", "debit", { reference: ws.receipt?.transaction_reference || "", actual: ws.receipt?.actual_minor ?? "", fee: ws.receipt?.actual_fee_minor ?? "", currency: ws.receipt?.currency || "" })]),
        prefill("Prepare reconciliation", "reconcile", { id, provider: ws.provider || "", account: ws.account_reference || "",
          ...(debit ? { statement: debit.statement_reference, line: debit.line_reference, reference: debit.transaction_reference,
            actual: debit.actual_minor, fee: debit.actual_fee_minor, currency: debit.currency, at: debit.booked_at.replace(/\+00:00$/, "Z") } : {}) })];
      case "paid": return [`Paid: exact outcome reconciled${ws.reconciliation ? ` by ${esc(ws.reconciliation.reconciled_by)} at ${date(ws.reconciliation.reconciled_at)}` : ""}. No further action.`];
      default: return ["Terminal state. No further action; history is append-only."];
    }
  }
  function manualWorkspace(w) {
    if (!w) return '<p class="notice">Manual operator workspace unavailable. Evidence and record IDs cannot be listed; no action was taken.</p>';
    const ev = w.evidence || [];
    return `<section id="manual-workspace"><h4>Operator workspace (read-only references)</h4>
      <p class="fine">Audit references only: the guided forms select records by readable descriptions and carry IDs internally. Listing never changes funds, policy or gates.
      Lists show the latest 200 evidence/recipient records, latest 100 financial requests, all pending review intents and latest 100 completed reviews.
      Retain older IDs in the secure operations register; records are never deleted.</p>
      <h4>Couple requests for staff review (no funds reserved)</h4>
      <p>Prepare a review, choose created or declined, and explicitly confirm. Created invokes the same guarded manual request/reservation.
      Creating requires enabled admission, exact policy scope and fees. Declining remains available OFF. No request auto-approves or sends money.</p>
      ${table(["Intent / wedding", "Amount", "Review", "Action"], (w.intents || []).map(i =>
        `<tr><td>${shortId(i.id)} / ${shortId(i.wedding_id)}</td><td>${esc(WS.money(Number(i.amount_minor), i.currency, false))}</td><td>${esc(i.status)}${i.payout_id ? ` / payout ${shortId(i.payout_id)}` : ""}</td><td>${i.status === "pending" ? prefill("Prepare staff review", "review-intent", { id: i.id, decision: "created" }) : "-"}</td></tr>`))}
      <details><summary>Evidence (${ev.length}; ${ev.filter(e => !(e.checks || []).length).length} unchecked)</summary>${table(["ID", "Kind", "Submitted", "Checks", "Action"], ev.map(e =>
        `<tr><td>${shortId(e.id)}</td><td>${esc(e.kind)}</td><td>${date(e.submitted_at)} by ${esc(e.submitted_by)}</td><td>${(e.checks || []).map(c => `${esc(c.checked_by)}${c.owner_solo ? " (Owner solo)" : ""}`).join("; ") || "unchecked"}</td><td>${prefill("Prepare check", "check", { id: e.id })}</td></tr>`))}</details>
      <details><summary>Registered accounts (${(w.accounts || []).length})</summary>${table(["Account", "Provider", "Evidence"], (w.accounts || []).map(a =>
        `<tr><td>${shortId(a.id)}</td><td>${esc(a.provider)}</td><td>${shortId(a.evidence_id)}</td></tr>`))}</details>
      <details><summary>Account scopes (${(w.custody || []).length})</summary>${table(["Scope", "Provider / account / currency", "Accounting model", "Action"], (w.custody || []).map(c =>
        `<tr><td>${shortId(c.id)}</td><td>${esc(c.provider)} / ${shortId(c.account_reference)} / ${esc(c.currency)}</td><td>${(w.sharedScopes || []).includes(c.id) ? "Shared account: WeddingSite attribution only; portal liquidity external" : c.latest_batch ? `Legacy statement ${shortId(c.latest_batch.id)} at ${date(c.latest_batch.statement_at)}` : "Legacy statement preparation required"}</td><td>${(w.sharedScopes || []).includes(c.id) ? prefill("Prepare contribution settlement proof", "attribute-settlement", { custody: c.id }) : prefill("Prepare next statement", "statement", { custody: c.id, previous: c.latest_batch?.id || "", opening: c.latest_batch?.closing_minor ?? "" })}</td></tr>`))}</details>
      <details><summary>Recipient revisions (${(w.recipients || []).length})</summary>${table(["Recipient revision", "Wedding", "Provider / currency", "Evidence"], (w.recipients || []).map(r =>
        `<tr><td>${shortId(r.id)} (#${esc(r.revision)})</td><td>${shortId(r.wedding_id)}</td><td>${esc(r.provider)} / ${esc(r.currency)}</td><td>${shortId(r.evidence_id)}</td></tr>`))}</details>
      <details><summary>Registered statement debits awaiting reconciliation (${(w.unreconciledDebits || []).length})</summary>${table(["Debit line", "Statement", "Reference", "Amount / fee", "Booked"], (w.unreconciledDebits || []).map(d =>
        `<tr><td>${shortId(d.line_reference)}</td><td>${shortId(d.statement_reference)}</td><td>${esc(d.transaction_reference)}</td><td>${esc(WS.money(Number(d.actual_minor), d.currency, false))} / ${esc(WS.money(Number(d.actual_fee_minor), d.currency, false))}</td><td>${date(d.booked_at)}</td></tr>`))}</details>
    </section>`;
  }
  async function moderationQueue(el) {
    const { cases = [] } = await get("moderation", "&closed=1");
    el.insertAdjacentHTML("afterbegin", `<section><h2>Moderation corrections</h2><p class="fine">Review the wedding changes before deciding. Republishing restores a previously published site; lifting a restriction returns it to the normal publication flow. No automatic publishing occurs.</p>${cases.map(c => `<article class="card">
      <h3>${esc(c.couple_names)}: ${esc(c.status)}</h3><p>${esc(c.reason)}</p><p><strong>Required action:</strong> ${esc(c.required_action)}</p>
      ${c.client_response ? `<p><strong>Client correction:</strong> ${esc(c.client_response)}</p>` : ""}
      <details class="policy-version"><summary>Current wedding details (private review)</summary><pre>${esc(JSON.stringify(c.current_details || {}, null, 2))}</pre></details>
      <details><summary>History</summary>${(c.history || []).map(h => `<p>${esc(h.event)} (${esc(h.actor)}): ${esc(h.note || "")}</p>`).join("")}</details>
      ${["open", "submitted", "returned"].includes(c.status) && !c.own_wedding ? `<form data-moderation-review="${esc(c.id)}" data-revision="${c.revision}">
        <label>Decision<select name="decision"><option value="lift">Lift restriction (leave unpublished)</option>${c.was_published ? '<option value="republish">Approve and republish</option>' : ""}${c.status === "submitted" ? '<option value="return">Return for more corrections</option>' : ""}</select></label>
        <label>Client-visible note (required when returning)<textarea name="note" maxlength="1000"></textarea></label>
        <button type="submit" class="mini">Confirm review decision</button></form>` : ""}</article>`).join("") || '<p>No moderation cases.</p>'}</section>`);
  }

  // Client-side search + pagination (default 20 per page, selectable).
  const pgState = {};
  function mountPaged(el, tab, cfg) {
    const st = (pgState[tab] = pgState[tab] || { page: 1, per: 20, q: "" });
    el.innerHTML = `<h2>${esc(cfg.title)}</h2><p class="fine">${esc(cfg.intro)}</p>
      <div class="pg-bar"><input type="search" class="pg-q" aria-label="Search ${esc(cfg.title)}" placeholder="Search..." value="${esc(st.q)}">
      <label class="pg-per-l">Per page <select class="pg-per">${[10, 20, 50, 100].map((n) => `<option value="${n}"${n === st.per ? " selected" : ""}>${n}</option>`).join("")}</select></label></div>
      <div class="pg-table"></div><div class="pg-pager"></div>`;
    const draw = () => {
      const q = st.q.toLowerCase();
      const hits = q ? cfg.items.filter((i) => cfg.text(i).toLowerCase().includes(q)) : cfg.items;
      const pages = Math.max(1, Math.ceil(hits.length / st.per));
      if (st.page > pages) st.page = pages;
      const slice = hits.slice((st.page - 1) * st.per, st.page * st.per);
      el.querySelector(".pg-table").innerHTML = table(cfg.head, slice.map(cfg.row));
      el.querySelector(".pg-pager").innerHTML = `<span class="fine">${hits.length} result${hits.length === 1 ? "" : "s"}${q ? " (filtered from " + cfg.items.length + ")" : ""} &middot; page ${st.page} of ${pages}</span>
        ${btn("Previous", `data-pg="-1"${st.page <= 1 ? " disabled" : ""}`)} ${btn("Next", `data-pg="1"${st.page >= pages ? " disabled" : ""}`)}`;
    };
    el.querySelector(".pg-q").addEventListener("input", (e) => { st.q = e.target.value; st.page = 1; draw(); });
    el.querySelector(".pg-per").addEventListener("change", (e) => { st.per = Number(e.target.value); st.page = 1; draw(); });
    el.querySelector(".pg-pager").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-pg]");
      if (b && !b.disabled) { st.page += Number(b.dataset.pg); draw(); }
    });
    draw();
  }

  async function weddingMetrics(el, id) {
    const { metrics: m } = await get("wedding-metrics", "&weddingId=" + encodeURIComponent(id));
    const w = m.wedding || {};
    const a = m.analytics || {};
    const cur = w.currency || "USD";
    const money = (v) => esc(WS.money(Number(v || 0), cur, false));
    const list = (rows, cols) => rows && rows.length ? table(cols.map((c) => c[0]), rows.map((r) => `<tr>${cols.map((c) => `<td>${c[1](r)}</td>`).join("")}</tr>`)) : '<p class="empty">Nothing here yet.</p>';
    el.innerHTML = `<p><button type="button" class="mini" data-wm-back="1">&larr; All weddings</button></p>
      <h2>${esc(w.couple_names || "Wedding")} <small class="fine">${esc(w.wedding_date || "")} &middot; ${w.archived ? "Archived" : w.published ? "Published" : "Draft"}</small></h2>
      <div class="stats">${stat("Confirmed RSVPs", a.rsvps_confirmed ?? 0)}${stat("Guests attending (incl. party)", m.party_size ?? 0)}${stat("Declined", a.rsvps_declined ?? 0)}
        ${stat("Visitors", a.visitors ?? 0)}${stat("Via referral links", a.referred_visitors ?? 0)}${stat("RSVPs from referrals", a.rsvps_referred ?? 0)}
        ${stat("Song bids", a.bids ?? 0)}${stat("Top bid", money(a.top_bid_minor))}</div>
      <h3>Funds raised by campaign</h3>${list(m.funds_by_campaign, [["Campaign", (r) => esc(r.campaign)], ["Payments", (r) => r.count], ["Gross", (r) => money(r.gross_minor)], ["Platform fee", (r) => money(r.platform_fee_minor)], ["Provider fee", (r) => money(r.provider_fee_minor)], ["Couple net", (r) => money(r.net_minor)]])}
      <h3>Top songs (bids added up)</h3>${list(m.top_songs, [["Song", (r) => esc(r.song)], ["Artist", (r) => esc(r.artist || "-")], ["Bids", (r) => r.bids], ["Total", (r) => money(r.total_minor)]])}
      <h3>Guests who invited others</h3>${list(m.top_inviters, [["Guest", (r) => esc(r.guest_name)], ["Visits", (r) => r.visits], ["RSVPs brought in", (r) => r.rsvps_brought]])}`;
  }
  const panels = {
    async referrals(el) {
      const [{ policy }, { history }, ledger] = await Promise.all([
        get("referral-policy"), get("referral-history"), get("referral-ledger")
      ]);
      const owner = role === "owner";
      const format = (minor, currency) => {
        const value = BigInt(minor), absolute = value < 0n ? -value : value;
        return `${currency} ${value < 0n ? "-" : ""}${(absolute / 100n).toLocaleString()}.${String(absolute % 100n).padStart(2, "0")}`;
      };
      el.innerHTML = `<h2>Client referrals: HELD estimates</h2>
        <p><strong>Payable: zero. No operational earnings, funding unlock, withdrawals or transfers.</strong>
        Verified platform settlement, full cost inventory and other commitments are not established.
        Commissions would be funded only from available platform revenue, never from couple net or provider amounts.</p>
        <form id="referral-policy-form" data-revision="${esc(policy.revision)}"><fieldset${owner ? "" : " disabled"}>
          <legend>Owner-controlled prospective policy</legend>
          <label><input type="checkbox" name="enabled"${policy.enabled ? " checked" : ""}> Enable held referral estimates</label>
          <label>Referral percentage (%)<input name="percent" type="number" min="0" max="100" step="0.01" value="${(policy.rate_basis_points / 100).toFixed(2)}" required></label>
          <p>Default OFF/0. A change affects newly admitted contributions only, including new contributions to eligible existing referred weddings. Old contributions are not repriced.
          Weddings created before first activation are permanently ineligible.</p>
          <label><input name="confirmed" type="checkbox" required> Confirm this revision-checked policy change; it does not enable payouts.</label>
          <button type="submit">${owner ? "Save referral policy" : "Owner access required"}</button></fieldset></form>
        <p>First effective time: ${esc(policy.first_effective_at || "Not activated")}. Terms ${esc(policy.terms_version)}.</p>
        <h3>Append-only policy history</h3>${table(["Time", "Old rate (basis points)", "New rate (basis points)", "Enabled"], history.map(h => `<tr><td>${esc(h.created_at)}</td><td>${esc(h.old_values.rate_basis_points)}</td><td>${esc(h.new_values.rate_basis_points)}</td><td>${esc(h.new_values.enabled)}</td></tr>`))}
        <h3>Signed estimate journal (latest 100)</h3>${table(["ID", "Wedding reference", "Currency", "Estimate adjustment", "Net verified basis", "Hold reasons"], ledger.entries.map(l => `<tr><td>${esc(l.id)}</td><td>${esc(l.wedding_id)}</td><td>${esc(l.currency)}</td><td>${esc(format(l.estimate_delta_minor, l.currency))}</td><td>${esc(format(l.basis_minor, l.currency))}</td><td>${esc(l.hold_reasons.join(", "))}</td></tr>`))}
        ${ledger.entries.length === 100 ? `<button type="button" id="referral-older" data-before="${esc(ledger.entries.at(-1).id)}">Load older journal entries</button><pre id="referral-older-entries"></pre>` : ""}
        <p>Partner accounts are not explicitly linked on this schema. Self-referral checks use creator, owner and client-authority account IDs only, not email. Ordinary helper grants do not invalidate a referral.
        Future payout blockers: verified platform revenue, commitments, eligibility/fraud controls, identity/KYC, tax review and separately approved payout authorization.</p>`;
    },
    async overview(el) {
      const o = cache.overview || (cache.overview = await get("overview"));
      el.innerHTML = `<h2>Platform overview</h2><div class="stats">
        ${stat("Weddings", o.weddings)}${stat("Published", o.published)}${stat("Archived", o.archived)}${stat("Past / completed", o.past)}
        ${stat("Users", o.users)}${stat("Staff", o.admins)}${stat("RSVPs", o.rsvps)}${stat("DJ bids", o.bids)}
        ${stat("Pending payouts", o.pending_payouts)}${stat("Test payments", o.test_payments)}</div>
        <p class="fine"><strong>Test-provider figures, not collected revenue or withdrawable cash.</strong> Original currency records are shown separately; bracketed USD/KES figures are indicative display conversions, not accounting entries.</p>
        <details class="context-help"><summary>How to read these currency figures</summary><p>${esc(window.WeddingSiteFX?.statusText() || "FX unavailable. Original currency figures are retained.")} Rates older than 36 hours are not used here. Different original currencies are never added together.</p></details>
        <div class="stats">${stat("Verified test contributions", esc(moneyMap(o.collected_by_currency)))}
        ${stat("Simulated platform fees", esc(moneyMap(o.fees_by_currency)))}
        ${stat("Known provider charges", esc(moneyMap(o.provider_fees_by_currency)))}
        ${stat("Simulated net after charges / holds", esc(moneyMap(o.settlement?.available_by_currency)))}
        ${stat("Refund/dispute adjustments", esc(moneyMap(o.settlement?.adjustments_by_currency)))}
        ${stat("Refund/dispute holds", esc(moneyMap(o.settlement?.refund_dispute_holds_by_currency)))}
        ${stat("Held pending provider fee", esc(moneyMap(o.provider_fee_holds_by_currency)))}
        ${stat("Publication fees", esc(moneyMap(o.publication_fees_by_currency)))}</div>
        <p class="fine">Checkout only accepts verified test-provider payments. Test checkout remains unavailable until provider keys, allowed currencies and markets, Turnstile site/secret keys, and a wedding-specific provider configuration are all ready. Payment credentials are never shown here.</p>`;
    },
    async operations(el) {
      const { queue: q, adjustments: financial = {} } = await get("operations");
      const reviews = q.payment_reviews || [];
      const kyc = q.kyc_exceptions || [];
      const reconciliations = q.reconciliations || [];
      const payouts = q.payouts || [];
      if (role === "owner") {
        const counts = q.counts || {};
        el.innerHTML = `<h2>Operational health</h2><p class="fine">Routine exception work is assigned to Admins. The Owner view is limited to aggregate escalations; no private KYC values are shown.</p>
          <div class="stats">${stat("Paid actions needing follow-up", counts.payment_reviews ?? 0)}${stat("KYC exceptions", counts.kyc_exceptions ?? 0)}
          ${stat("Reconciliation differences", counts.reconciliations ?? 0)}${stat("Payouts awaiting staff action", counts.payouts ?? 0)}
          ${stat("Refund / dispute holds", financial.count ?? 0)}</div>`;
        return;
      }
      const reviewRows = reviews.map((r) => `<tr><td>${date(r.created_at)}</td><td>${esc(r.couple_names)}</td><td>${esc(r.reason_code)}</td>
        <td>${btn("Wedding metrics", `data-ops-wedding="${esc(r.wedding_id)}"`)}</td></tr>`);
      const kycRows = kyc.map((w) => `<tr><td>${esc(w.couple_names)}</td><td>${esc(w.wedding_date || "-")}</td>
        <td>${btn("Review wedding", `data-ops-wedding="${esc(w.id)}"`)}</td></tr>`);
      const reconRows = reconciliations.map((r) => `<tr><td>${date(r.created_at)}</td><td>${esc(r.couple_names)}</td><td>${esc(r.provider)}</td>
        <td>${esc(WS.money(Number(r.expected_minor || 0), r.currency, false))}</td><td>${esc(WS.money(Number(r.reported_minor || 0), r.currency, false))}</td>
        <td>${esc(r.status)}</td></tr>`);
      const payoutRows = payouts.map((p) => `<tr><td>${date(p.requested_at)}</td><td>${esc(p.couple_names)}</td>
        <td>${esc(WS.money(Number(p.amount_minor || 0), p.currency, false))}</td><td>${esc(p.status)}</td></tr>`);
      const adjustmentRows = (financial.adjustments || []).map((a) => {
        const allocation = a.can_resolve
          ? `<select data-refund-allocation="${esc(a.id)}" aria-label="Refund cost allocation">
              ${(a.refund_fee_allocation === "manual_review"
                ? [["couple", "Charge full refund to couple"], ["platform", "Platform absorbs known fees"]]
                : [[a.refund_fee_allocation, a.refund_fee_allocation === "platform" ? "Saved policy: platform absorbs known fees" : "Saved policy: couple absorbs full refund"]])
                .map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select>
             ${btn("Record allocation", `data-refund-id="${esc(a.id)}"`)}`
          : a.adjustment_kind === "refund" && a.status === "review" && a.resolution_code === "provider_fee_unknown"
            ? "Provider fee not reconciled; payout hold remains"
            : "-";
        return `<tr><td>${date(a.created_at)}</td><td>${esc(a.couple_names)}</td><td>${esc(a.provider)}</td>
          <td>${esc(a.adjustment_kind)}</td><td>${esc(WS.money(Number(a.amount_minor || 0), a.currency, false))}</td>
          <td>${esc(a.status)}${a.hold_minor ? ` · held ${esc(WS.money(Number(a.hold_minor), a.currency, false))}` : ""}</td>
          <td>${esc(a.resolution_code || "-")}</td><td>${allocation}</td></tr>`;
      });
      const unmatchedRows = (financial.unmatched_events || []).map((event) => `<tr><td>${date(event.received_at)}</td>
        <td>${esc(event.provider)}</td><td>${esc(event.event_type)}</td><td>${esc(event.provider_payment_reference || "-")}</td>
        <td>${esc(event.reason_code || event.outcome)}${event.can_match ? `<div><input data-refund-match-contribution="${esc(event.id)}" aria-label="Contribution ID for provider event ${esc(event.id)}" placeholder="Contribution ID">
          ${btn("Match & hold", `data-refund-event="${esc(event.id)}"`)}</div>` : ""}</td></tr>`);
      el.innerHTML = `<h2>Admin exception queue</h2><p class="fine">Work unresolved exceptions first. Paid action failures do not authorize a second charge; reconcile the verified payment before any manual fulfilment. KYC completeness is not independent identity verification.</p>
        <h3>Paid actions needing follow-up (${reviews.length})</h3>${table(["Detected", "Wedding", "Reason", "Next step"], reviewRows)}
        <h3>KYC completeness exceptions (${kyc.length})</h3>${table(["Wedding", "Date", "Next step"], kycRows)}
        <h3>Reconciliation differences (${reconciliations.length})</h3>${table(["Detected", "Wedding", "Provider", "Expected", "Reported", "Status"], reconRows)}
        <h3>Payouts awaiting staff action (${payouts.length})</h3>${table(["Requested", "Wedding", "Amount", "Status"], payoutRows)}
        <h3>Provider refunds and disputes (${financial.count ?? 0})</h3>
        <p class="fine">Only signed, normalized provider events are considered. Pending refunds and open disputes reserve withdrawable funds. Refund allocations use the policy captured when payment was created; unknown provider fees stay held. Recording an allocation does not initiate a refund.</p>
        ${table(["Detected", "Wedding", "Provider", "Type", "Amount", "Status / hold", "Reason", "Action"], adjustmentRows)}
        <h3>Unmatched provider events (${(financial.unmatched_events || []).length})</h3>
        ${table(["Received", "Provider", "Event", "Payment reference", "Reason"], unmatchedRows)}
        <p class="fine">Automated disbursement and provider-side refund initiation are not enabled. Staff records only the allocation for refunds already confirmed by a provider.</p>`;
    },
    async weddings(el) {
      if (el.dataset.wedding) return weddingMetrics(el, el.dataset.wedding);
      const { weddings } = await get("weddings");
      mountPaged(el, "weddings", {
        title: "All weddings",
        intro: "Weddings are never deleted: they can only be unpublished or archived (reversible). Click Metrics for a per-wedding drill-down.",
        head: ["Couple", "Owner", "Date / zone", "State", "RSVPs/Bids", "Collected", "Pub. fee", "KYC", "Actions"],
        items: weddings,
        text: (w) => [w.couple_names, w.owner_email, w.slug, w.fee_status].join(" "),
        row: (w) => {
          const state = w.archived_at ? "Archived" : w.is_past ? "Completed" : w.published_at ? "Published" : "Draft";
          const acts = [
            btn("Metrics", `data-wm="${esc(w.id)}"`),
            w.published_at && !w.archived_at ? btn("Unpublish", `data-wa="unpublish" data-id="${esc(w.id)}"`) : "",
            w.archived_at ? btn("Restore", `data-wa="restore" data-id="${esc(w.id)}"`) : btn("Archive", `data-wa="archive" data-id="${esc(w.id)}"`),
            w.fee_status !== "paid" && w.fee_status !== "waived" ? btn("Waive fee", `data-wa="waive_fee" data-id="${esc(w.id)}"`) : "",
            w.slug && w.published_at ? `<a class="mini" href="${esc(window.WSSite ? WSSite.weddingUrl(w.slug) : "/guest.html?slug=" + encodeURIComponent(w.slug))}" target="_blank" rel="noopener">Guest site</a>` : ""
          ].join(" ");
          return `<tr><td>${esc(w.couple_names)}</td><td>${esc(w.owner_email || "-")}</td><td>${esc(w.wedding_date || "-")} ${esc(w.time_zone || "")}</td>
            <td>${state}</td><td>${w.rsvps}/${w.bids}</td><td>${esc(WS.money(Number(w.collected_minor), w.currency, false))}</td>
            <td>${esc(w.fee_status)}</td><td>${w.kyc_complete ? "Complete" : "Missing"}</td><td class="acts">${acts}</td></tr>`;
        }
      });
    },
    async users(el) {
      const search = el.dataset.search || "";
      const { users } = await get("users", search ? "&search=" + encodeURIComponent(search) : "");
      const canRole = ["owner", "superadmin"].includes(role);
      const me = WS.session().user?.id;
      mountPaged(el, "users", {
        title: "Users & roles",
        intro: canRole ? "SuperAdmins can manage clients and regular Admins. Only the protected Owner manages SuperAdmins. Self-changes and Owner reassignment are prohibited; changes are audited." : "Client and regular Admin roles are visible for support. Only SuperAdmins and the protected Owner may change roles.",
        head: ["Email", "Name", "Role", "Weddings", "Joined"],
        items: users,
        text: (u) => [u.email, u.display_name, u.platform_role].join(" "),
        row: (u) => {
          const sel = canRole && u.id !== me && u.platform_role !== "owner" && (role === "owner" || u.platform_role !== "superadmin")
            ? `<select data-role-for="${esc(u.id)}" aria-label="Role for ${esc(u.email)}">${(role === "owner" ? ["client", "admin", "superadmin"] : ["client", "admin"]).map((r) => `<option value="${r}"${r === u.platform_role ? " selected" : ""}>${r}</option>`).join("")}</select> ${btn("Apply", `data-setrole="${esc(u.id)}"`)}`
            : esc(u.platform_role);
          return `<tr><td>${esc(u.email || "-")}</td><td>${esc(u.display_name || "-")}</td><td>${sel}</td><td>${u.wedding_count}</td><td>${date(u.created_at)}</td></tr>`;
        }
      });
    },
    async fees(el) {
      const [{ policies: p }, refundPolicy, paymentControls] = await Promise.all([get("policies"), get("refund-policy"), get("payment-controls")]);
      let defaultCurrencyData = null, defaultCurrencyError = "";
      if (role === "owner") {
        try { defaultCurrencyData = await get("default-currency"); }
        catch (error) { defaultCurrencyError = error.message; }
      }
      const extendedPolicy = ["contribution_fixed_fee_minor", "contribution_fixed_fee_currency", "min_payout_minor", "payout_hold_days"]
        .every((key) => Object.prototype.hasOwnProperty.call(p, key));
      const { history = [] } = extendedPolicy ? await get("policy-history") : {};
      const major = (v) => (v === null || v === undefined ? "" : (Number(v) / 100).toFixed(2));
      const f = (id, label, val, hint, max = "") => `<label for="${id}">${esc(label)}</label><input id="${id}" type="number" min="0" ${max ? `max="${max}"` : ""} step="0.01" value="${esc(major(val))}" required><span class="fine">${esc(hint)}</span>`;
      const g = (id, label, val, hint) => `<label for="${id}">${esc(label)}</label><input id="${id}" type="number" min="0" step="1" value="${esc(val ?? "")}" required><span class="fine">${esc(hint)}</span>`;
      const owner = role === "owner";
      const percent = (Number(p.contribution_fee_basis_points || 0) / 100).toFixed(2);
      el.innerHTML = `<h2>Fees & settings</h2>
        <p class="fine"><strong>How publication fees combine:</strong> (1) a paid or waived fee is never charged twice; (2) if the wedding date is further away than the far-future threshold, the far-future fee applies (this overrides the free allowance); (3) otherwise the client's first N published weddings are free; (4) after that the standard per-wedding fee applies.</p>
        <p class="fine"><strong>Units:</strong> money fields are entered in major units with 2 decimals (<code>15.50 &times; 100 = 1550</code> minor units). <strong>Publication fee policy is always USD.</strong> Clients see the converted wedding-currency quote with its USD base and rate timestamp. Other limits and balances remain in the stated transaction/wedding currency.</p>
        <p class="fine"><strong>Commission:</strong> this is deducted from the wedding's proceeds, not added as a guest surcharge. Each new transaction snapshots the policy; later changes do not reprice existing payments. Unknown provider charges are not guessed.</p>
        <form id="fees-form"><fieldset${owner ? "" : " disabled"}>
        ${f("p-fee", "Standard publication fee (USD)", p.publication_fee_minor, "USD base, converted at a fresh quoted rate after the free allowance is used.")}
        ${g("p-ff-months", "Far-future threshold (months)", p.far_future_months, "Weddings further away than this are charged the far-future fee.")}
        ${f("p-ff-fee", "Far-future fee (USD)", p.far_future_fee_minor, "USD base; applies before the free allowance.")}
        ${g("p-free", "Free publications per client", p.free_publications_per_client, "First N published weddings per client are free.")}
        <label for="p-percent">Platform commission (%)</label><input id="p-percent" type="number" min="0" max="100" step="0.01" value="${esc(percent)}" required><span class="fine">Deducted from each verified payment. Stored to the nearest 0.01% (basis points).</span>
        ${extendedPolicy ? `${f("p-fixed-fee", "Optional fixed commission", p.contribution_fixed_fee_minor, "Wallet payments apply this only in the policy currency. Live Paystack requires a USD base and converts it at immutable quoted FX.")}<label for="p-fixed-currency">Fixed commission currency</label><input id="p-fixed-currency" type="text" minlength="3" maxlength="3" pattern="[A-Za-z]{3}" value="${esc(p.contribution_fixed_fee_currency || "USD")}" required><span class="fine">Live Paystack holds a nonzero non-USD fixed-fee policy; historical payments and other providers are not converted or repriced.</span>` : '<p class="fine">Fixed commission and settlement-hold controls will appear after the financial policy migration is validated and applied.</p>'}
        ${f("p-max", "Max single contribution", p.max_contribution_minor, "Safety cap per payment.")}
        ${f("p-max-payout", "Maximum withdrawal", p.max_payout_minor, "Per-request limit; available balance and holds are checked separately.")}
        ${extendedPolicy ? `${f("p-min-payout", "Minimum withdrawal", p.min_payout_minor, "Minimum amount per payout request; available funds and other holds are checked separately.")}${g("p-hold-days", "Platform payment hold (days)", p.payout_hold_days, "For new confirmed payments only. 0 means no platform time delay. Existing stored dates stay unchanged; verified fees, other holds and portal liquidity still matter. This is not provider settlement proof.")}` : ""}
        <button type="submit"${owner ? "" : " disabled"}>${owner ? "Save settings" : "Owner access required"}</button></fieldset></form>
        <p class="fine">Only the protected Owner can change platform fee and payout policies. SuperAdmins can view these settings; regular Admins cannot access them. Transaction eligibility and fee calculation are enforced server-side.</p>
        ${extendedPolicy ? `<details><summary>Recent policy versions (${history.length})</summary>${history.length ? history.map((h) => `<article class="policy-version"><strong>${date(h.changed_at)}</strong><pre>${esc(JSON.stringify({ old: h.old_values, new: h.new_values }, null, 2))}</pre></article>`).join("") : '<p class="fine">No policy changes have been recorded yet.</p>'}</details>` : ""}`;
      if (owner) {
        const supported = defaultCurrencyData?.currencies || [];
        const current = defaultCurrencyData?.currency || "";
        const options = supported.map(item => `<option value="${esc(item.code)}"${item.code === current ? " selected" : ""}>${esc(item.code)} - ${esc(item.name)}</option>`).join("");
        const unsupportedCurrent = current && !supported.some(item => item.code === current)
          ? `<option value="${esc(current)}" selected>${esc(current)} - currently unavailable</option>` : "";
        el.insertAdjacentHTML("beforeend", `<section id="default-currency-settings" class="notice" aria-labelledby="default-currency-heading">
          <h3 id="default-currency-heading">Owner: default currency</h3>
          <p>Used only to preselect a supported currency for new wedding drafts and as the initial display preference for public indicative USD quotes. USD remains the canonical publication-fee currency; quotes use fresh daily rates. Existing weddings, saved currencies, invoices, payments and historical records are not converted or changed.</p>
          ${defaultCurrencyError
            ? `<p class="fine" role="status">Supported currencies could not be checked: ${esc(defaultCurrencyError)}. Reload this panel before changing the setting.</p>`
            : `<form id="default-currency-form"><label for="platform-default-currency">New-wedding default</label>
              <select id="platform-default-currency" name="currency"${defaultCurrencyData ? "" : " disabled"}>
                <option value=""${!current ? " selected" : ""}>No explicit default (USD legacy behavior)</option>${unsupportedCurrent}${options}
              </select>
              <button type="submit"${defaultCurrencyData ? "" : " disabled"}>Save default currency</button></form>
              <p class="fine" role="status">${current
                ? `Current default: ${esc(current)}${defaultCurrencyData.supported ? " (currently supported)" : " (not currently supported; new drafts require a supported choice)"}`
                : "No Owner-selected default; new drafts retain the USD fallback."}</p>`}
        </section>`);
      }
      const refundAllocation = refundPolicy.allocation || "manual_review";
      const dj = paymentControls.daraja || {};
      const djLive = dj.configuredEnvironment === "production";
      const ps = paymentControls.paystack || {};
      let publicationAdjustments = [], publicationReviewUnavailable = false;
      try { publicationAdjustments = (await get("paystack-publication-adjustments")).adjustments || []; }
      catch { publicationReviewUnavailable = true; }
      const providerLabels = { daraja: djLive ? "M-Pesa — Daraja (LIVE credentials configured)" : "M-Pesa — Daraja sandbox", paystack: ps.environment === "live" ? "Card — Paystack (live, separate approval gates)" : "Card — Paystack test", stripe: "Card — Stripe test" };
      el.insertAdjacentHTML("beforeend", `<section id="daraja-status" class="notice${dj.newLiveCollection === "gates_open" ? " bad" : ""}"><h3>M-Pesa collection status</h3>
        <p>Configured environment: <strong>${esc(dj.configuredEnvironment || "unknown")}</strong>. New live collection: <strong>${dj.newLiveCollection === "gates_open" ? "approval gates OPEN — guests can be charged real money if the platform M-Pesa switch below is enabled and provider health/Turnstile pass" : "held (not accepting)"}</strong>. Environment kill switch: ${dj.killSwitchOn ? "on" : "off"}. Owner approval: ${dj.approvalUnavailable ? "unavailable (read failed)" : dj.ownerApproved === true ? "granted" : "not granted"}. Live payouts: off.</p>
        ${dj.reason ? `<p class="fine">${esc(dj.reason)}</p>` : ""}
        <p class="fine">Only the protected Owner can change live approval; SuperAdmin and Admin cannot. Live funds are held with unknown provider fees pending and no automatic payout. Already-admitted live payments are still reconciled while collection is held.</p></section>
        ${owner ? `<section id="daraja-owner" class="notice" aria-labelledby="daraja-owner-h"><h3 id="daraja-owner-h">Owner: live M-Pesa approval</h3>
        <p><strong>Warning:</strong> approving live M-Pesa lets guests be charged real money once the environment kill switch is on. Funds are held, provider fees stay pending and payouts remain off. This is a separate step from any real-money test.</p>
        <button type="button" id="daraja-check">Run readiness check (no payment)</button>
        <div id="daraja-readiness" class="fine" role="status" aria-live="polite"></div>
        <form id="daraja-approval-form"><p class="fine">Approves the PayBill shortcode already configured and confirmed on this deployment (never shown or typed here). Approval requires a passing OAuth readiness probe.</p>
        <button type="submit">Approve live M-Pesa collection</button>
        <button type="button" id="daraja-revoke">Revoke approval</button></form></section>` : ""}
        <form id="payment-controls-form"><h3>Enabled payment methods</h3>
        <p class="fine">SuperAdmin and Owner controls for new checkouts across all weddings. Enabling a switch never enables live mode or supplies missing credentials. Pending payments remain with their original provider and can still be verified.</p>
        ${(paymentControls.providers || []).map(provider => `<label><input type="checkbox" name="payment-provider" value="${esc(provider.id)}"${(paymentControls.enabled || []).includes(provider.id) ? " checked" : ""}>
          ${esc(providerLabels[provider.id] || provider.id)} — ${provider.configured ? (provider.id === "daraja" && djLive ? "Configured for live reconciliation (new collection per status above)" : provider.id === "paystack" && ps.environment === "live" ? "Live Paystack configured (new collection per approval status)" : "Test adapter configured (health checked at checkout)") : "Setup incomplete or unsupported currency/market"}</label>`).join("")}
        <button type="submit">Save payment methods</button></form>`);
      el.insertAdjacentHTML("beforeend", `<section class="notice" id="paystack-finance">
        <h3>Paystack live collection</h3>
        <p>Environment: ${esc(ps.environment || "unconfigured")}. Owner approval: ${ps.approved ? "granted" : "held"}.
        New collection: ${esc(ps.newCollection || "held")}. Collection kill switch: ${ps.collectionKillSwitchOn ? "on" : "off"}.
        Publication kill switch: ${ps.publicationKillSwitchOn ? "on" : "off"}. Independent reconciliation: ${ps.reconciliationEnabled ? "on" : "off"}.</p>
        ${ps.reason ? `<p class="notice">${esc(ps.reason)}</p>` : ""}
        <p>Selected guest settlement mode: <strong>${esc(ps.settlementMode || "standard")}</strong>.
        Standard collection credits the platform-held wedding ledger; existing fee/settlement holds, KYC and the OFF payout gate still apply.
        Split proceeds go directly to the couple and can never be withdrawn again here. Publication fees always remain platform-only.</p>
        <p class="fine">${esc(ps.splitHoldingReason || "")} Fixed live Paystack commission uses USD policy and immutable FX.</p>
        ${owner ? `<form id="paystack-mode-form"><h4>Owner settlement-mode control</h4>
          <input type="hidden" name="policyRevision" value="${esc(ps.policyRevision || "")}">
          <label>New guest payments<select name="mode"><option value="standard"${ps.settlementMode === "split" ? "" : " selected"}>Standard: platform-collected</option><option value="split"${ps.settlementMode === "split" ? " selected" : ""}${ps.splitReady ? "" : " disabled"}>Split: direct to couple (requires verified contract and onboarding)</option></select></label>
          <p>Changing mode never reroutes existing checkouts, refunds or payouts. No automatic split-to-standard fallback. Saving does not activate live payments.</p>
          <button type="submit"${ps.policyRevision ? "" : " disabled"}>Save settlement mode</button>
        </form>
        <form id="paystack-policy-form"><h4>Owner approval (does not change environment switches)</h4>
          <input type="hidden" name="policyRevision" value="${esc(ps.policyRevision || "")}">
          <label>Account-confirmed market/currency pairs (JSON)<textarea name="capabilities" required placeholder='[{"market":"KE","currency":"KES"}]'>${esc(JSON.stringify(ps.capabilities || []))}</textarea></label>
          <label>Split provider fee bearer<select name="feeBearer"><option value="subaccount"${ps.feeBearer === "account" ? "" : " selected"}>Couple/subaccount (platform receives its fee)</option><option value="account"${ps.feeBearer === "account" ? " selected" : ""}>Platform (provider charge reduces platform fee)</option></select></label>
          <label><input name="standardEnabled" type="checkbox"${ps.standardApproved ? " checked" : ""}> Approve standard platform-collected guest payments</label>
          <label><input name="splitEnabled" type="checkbox"${ps.splitApproved ? " checked" : ""}> Approve guest Split Payments</label>
          <label><input name="publicationEnabled" type="checkbox"${ps.publicationApproved ? " checked" : ""}> Approve platform-only live publication payments</label>
          <label><input name="eligibilityConfirmed" type="checkbox" required> I verified this merchant's supported market/currency pairs and selected collection scopes with Paystack, and understand activation can charge real money. Standard collection does not require split eligibility.</label>
          <button type="submit"${ps.policyRevision ? "" : " disabled"}>Save Owner approval</button><button id="paystack-revoke" type="button"${ps.policyRevision ? "" : " disabled"}>Revoke approval</button>
        </form>
        <form id="paystack-destination-form"><h4>Verify a pre-existing couple subaccount</h4>
          <p>This performs a read-only Paystack verification. It never creates a provider subaccount or changes bank details; couple consent is reset after re-verification.</p>
          <label>Wedding ID<input name="weddingId" type="text" required></label>
          <label>Existing subaccount code<input name="subaccountCode" type="text" pattern="ACCT_[A-Za-z0-9]+" required autocomplete="off"></label>
          <button type="submit">Verify destination (no financial operation)</button>
        </form>` : ""}
        <form id="paystack-settlement-form"><h4>Reconcile split provider settlement statement</h4>
          <p>Read-only provider checks plus an immutable internal record. Missing allocation data, deductions and mismatches remain for review; no transfer or refund is initiated.</p>
          <label>Contribution ID<input name="contributionId" type="text" required></label>
          <label>Provider settlement ID<input name="settlementId" type="text" pattern="[1-9][0-9]*" required></label>
          <button type="submit">Verify settlement statement</button>
        </form>
        <h4>Publication refund/dispute review (${publicationReviewUnavailable ? "unavailable" : publicationAdjustments.length})</h4>
        ${publicationReviewUnavailable ? '<p class="notice">Paystack publication review could not be loaded. Resolve this before reviewing cases; other provider controls remain available.</p>' : ""}
        <p>These cases hold new publication actions. Historical checkout and adjustment evidence is retained. This decision does not move funds or unpublish an existing wedding.</p>
        ${publicationAdjustments.map(a => `<article><p>${esc(a.provider_state)}: ${esc(WS.money(a.amount_minor,a.currency,false))} — checkout ${esc(a.checkout_id)}</p>
          ${owner ? `<form class="paystack-publication-resolution" data-event="${esc(a.event_id)}">
            <label>Entitlement decision<select name="outcome"><option value="require_payment">Require a new payment after review</option><option value="waive">Owner waives the fee</option><option value="retain_paid">Retain paid entitlement (restored/failed adjustment only)</option></select></label>
            <label>Reason<input name="reason" minlength="10" maxlength="240" required></label>
            <button type="submit">Resolve publication entitlement</button></form>` : ""}</article>`).join("")}
        </section>`);
      el.insertAdjacentHTML("beforeend", `<form id="refund-policy-form"><h3>Refund fee allocation</h3>
        <p class="fine">This applies to new payments only. “Couple” assigns the full provider-confirmed refund to the wedding balance. “Platform” reimburses the couple for the known original platform and provider fees proportionally; unknown provider fees remain held. “Manual review” is the safest default and keeps refund amounts unavailable until an Admin records an allocation.</p>
        <label for="refund-allocation">Default allocation</label><select id="refund-allocation"${owner ? "" : " disabled"}>
          ${[["manual_review", "Manual review (recommended)"], ["couple", "Couple absorbs the full refund"], ["platform", "Platform absorbs known fees"]]
            .map(([value, label]) => `<option value="${value}"${refundAllocation === value ? " selected" : ""}>${label}</option>`).join("")}
        </select><button type="submit"${owner ? "" : " disabled"}>${owner ? "Save refund policy" : "Owner access required"}</button></form>`);
    },
    async ledger(el) {
      const { ledger } = await get("ledger");
      mountPaged(el, "ledger", {
        title: "Ledger",
        intro: "Newest 500 contributions across all weddings. test-simulator rows are simulated.",
        head: ["Date", "Wedding", "Type / purpose", "Contributor", "Amount", "Fee", "Net", "Status", "Provider"],
        items: ledger,
        text: (l) => [l.couple_names, l.stream_name, l.status, l.provider].join(" "),
        row: (l) => `<tr><td>${date(l.created_at)}</td><td>${esc(l.couple_names)}</td><td>${esc(l.stream_name)}</td><td>${esc(l.contributor || "Anonymous")}</td><td>${esc(WS.money(l.amount_minor, l.currency, false))}</td><td>${esc(WS.money(Number(l.fee_minor || 0), l.currency, false))}</td><td>${esc(WS.money(Number(l.net_minor || 0), l.currency, false))}</td><td>${esc(l.status)}</td><td>${esc(l.provider || "-")}</td></tr>`
      });
    },    async payouts(el) {
      manualSetup = await import("./manual-payout-setup.js");
      const [{ payouts }, manual, workspace] = await Promise.all([get("payouts"), get("manual-payouts"), get("manual-payout-workspace").catch(() => null)]);
      if (workspace) workspace.requestDetails = manual.requests || [];
      cache.manualWorkspace = workspace;
      el.innerHTML = `<h2>Payouts / withdrawals</h2><section id="simple-payout-admin"></section>
        ${role === "owner" ? '<section id="owner-payment-fees"></section>' : ""}
        <details id="advanced-payout-history"><summary>Older controlled payouts and historical evidence (advanced)</summary>
        <section id="manual-payout-control"><h3>Controlled manual external payouts: ${manual.enabled ? "enabled" : "OFF"}</h3>
          <p>This manual control never changes automatic B2C policy or sends money. Code readiness does not authorize use of a funded merchant rail. Operators transfer only outside this site in the official authorized portal, after a durable execution claim. Never resend an uncertain transfer.</p>
          <p>${esc(manual.verification)}</p>
          <p class="notice">${(manual.blockers || []).map(esc).join(". ")}.</p>
          <p>Request &rarr; review &rarr; execution claim &rarr; receipt reported &rarr; exact outcome reconciliation. Other eligible leaders require two distinct actors. The protected Owner may explicitly opt into audited solo manual mode; evidence, funds and reconciliation are still mandatory. Uncertain outcomes retain internal exposure; there is no timeout release.</p>
          <p>Shared Paybill: only attributable settled wedding net, WeddingSite obligations and disbursements are tracked. Internal reservations are NOT bank reservations or liquidity guarantees.
          The authorized operator checks portal liquidity externally. No other-system receipts or whole-account balance are requested.
          Legacy statement-mode requests still require their existing line exactly and atomically allocate it before paid.</p>
          <p>Evidence reference fields accept opaque repository UUIDs only. Do not enter bank details, names, KYC, credentials or public document URLs. Identity evidence must include consent and actual verification by the appointed reviewer; an attestation is not a provider lookup.</p>
          <p>Evidence intake and existing-claim outcomes remain available while manual admission is OFF. Approval/execution always recheck the current policy revision, limits, fees, recipient and statement.</p>
          ${manualPolicyForm(manual.readiness)}
          <p id="manual-last-result" role="status">${esc(manualResult)}</p>
          ${manualWorkspace(workspace)}
          ${manualForms(Boolean(manual.enabled))}
          ${role === "owner" ? `<details><summary>Protected Owner: record policy evidence (separate review required)</summary>
            <form data-manual-action="evidence"><input type="hidden" name="kind" value="policy">
              <label>Opaque policy document reference (UUID)<input name="reference" required data-contact-allowed autocomplete="off"></label>
              <label>Policy evidence SHA-256 digest<input name="sha256" pattern="[0-9a-f]{64}" required data-contact-allowed autocomplete="off"></label>
              <label><input name="confirmed" type="checkbox" required> Record opaque human review evidence only; this does not verify a provider or activate admission.</label>
              <button type="submit">Record Owner policy evidence</button></form></details>` : ""}
          ${(manual.heldAccounts || []).map(h => `<p role="alert">Custody account held across both payout channels: ${esc(h.custody_id)}; incident ${esc(h.id)}, request ${esc(h.payout_id)} (${date(h.recorded_at)}). Contradictory outcome requires separate incident review; no release or resend action is available.</p>`).join("")}
          ${(manual.requests || []).map(r => `<article><h4>${esc(r.id)}: ${esc(r.state)}</h4><p>${esc(WS.money(Number(r.amount_minor),r.currency,false))}; recipient revision ${esc(r.recipient_revision)}; ${r.owner_solo ? "explicit Owner solo mode" : "two-person review"}</p>${(([text, ...actions]) => `<p class="notice" data-manual-next="${esc(r.state)}">${text}</p>${actions.length ? `<p class="acts">${actions.join(" ")}</p>` : ""}`)(manualNextStep(r, workspace || {}))}<details><summary>Append-only actor / evidence history</summary>${(r.events || []).map(e => `<p>${esc(e.state)}: actor ${esc(e.actor_id)}, evidence ${esc(e.evidence_id || "-")}, Owner solo: ${e.owner_solo ? "yes" : "no"} (${date(e.created_at)})</p>`).join("")}</details></article>`).join("")}
        </section><h3>Legacy requests (cannot be approved or marked sent)</h3><p class="fine">Identity submissions are not independent recipient verification. <a href="/wedding.html">Wedding identity details</a> remain private. A bare Mark sent can never declare payment.</p>` +
        table(["Requested", "Wedding", "Amount", "Status", "Note", "Actions"], payouts.map((p) => {
          const acts = [];
          if (["requested", "approved"].includes(p.status)) acts.push(btn("Cancel legacy request", `data-ps="cancelled" data-id="${esc(p.id)}"`));
          return `<tr><td>${date(p.requested_at)}</td><td>${esc(p.couple_names)} <a href="/wedding.html?id=${encodeURIComponent(p.wedding_id)}#kyc-section">KYC details</a></td><td>${esc(WS.money(Number(p.amount_minor), p.currency, false))}</td><td>${esc(p.status)}</td><td>${esc(p.note || "")}</td><td class="acts">${acts.join(" ") || "-"}</td></tr>`;
        })) + "</details>";
      manualSetup.mountSetup(el, { workspace, weddings: workspace?.weddings || [], role, esc });
      const simple = await import("./simple-payouts.js");
      try { await simple.mountAdmin(el.querySelector("#simple-payout-admin"), { api: WS.api, money: WS.money, esc, role }); }
      catch { el.querySelector("#simple-payout-admin").textContent = "Simple payout service unavailable. Refresh before making any transfer; old history remains available below."; }
      if (role === "owner") {
        try { await simple.mountPaymentFees(el.querySelector("#owner-payment-fees"), { api: WS.api, money: WS.money, esc }); }
        catch { el.querySelector("#owner-payment-fees").textContent = "Payment fee reconciliation unavailable. Refresh later; do not assume an unknown fee is zero."; }
      }
    },
    async b2c(el) {
      await window.B2CBackoffice.mount(el, role === "owner");
    },
    async audit(el) {
      const { audit } = await get("audit");
      mountPaged(el, "audit", {
        title: "Audit log",
        intro: "Newest 500 events.",
        head: ["When", "Actor", "Action", "Table"],
        items: audit,
        text: (a) => [a.actor, a.action, a.table_name].join(" "),
        row: (a) => `<tr><td>${date(a.created_at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.table_name || "")}</td></tr>`
      });
    },    async security(el) {
      el.innerHTML = `<h2>Security guidance</h2><ul class="guide">
        <li>Use a unique password of 12+ characters for the Owner account and rotate it if it was ever shared.</li>
        <li>The Owner controls all Admin/SuperAdmin delegation; changes are audited and the protected Owner identity cannot be reassigned from this screen.</li>
        <li>ID/passport numbers are stored privately and masked; only staff can reveal them and each reveal is audited.</li>
        <li>MFA enrolment is not built into Join Our Wedding yet: enable MFA on the email account used for recovery.</li>
        <li>Live M-Pesa and Paystack each require independent environment switches and protected Owner approval. M-Pesa wallet funds remain held with payouts disabled; Paystack direct proceeds can never be withdrawn again here. Publication is platform-only.</li>
        <li>Review the audit log regularly for unexpected role changes or fee waivers.</li></ul>`;
    }
  };

  async function show(tab) {
    document.querySelectorAll(".tab-btn").forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle("active", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    const el = $("panel");
    el.innerHTML = '<p class="fine">Loading...</p>';
    el.dataset.tab = tab;
    try {
      await panels[tab](el);
      if (tab === "operations") await moderationQueue(el);
    } catch (e) {
      el.innerHTML = `<p class="notice bad">${esc(e.message)}</p>`;
    }
  }

  async function init(opts) {
    if (!WS.token()) return location.replace("/signin.html");
    try {
      role = (await get("role")).role;
    } catch {
      toast("You do not have access to this area.", true);
      return setTimeout(() => location.replace("/dashboard.html"), 1200);
    }
    if (opts.ownerOnly && role !== "owner") return location.replace("/account.html");
    $("role-badge").textContent = "Role: " + role;
    const tabs = role === "admin" ? ["operations", "weddings", "users"] : ["overview", "operations", "weddings", "users", "fees", "referrals", "ledger", "payouts", "audit", "security"];
    if (["owner", "superadmin"].includes(role) && window.B2CBackoffice) tabs.splice(tabs.indexOf("audit"), 0, "b2c");
    $("admin-nav").innerHTML = tabs.map((t, i) => `<button type="button" class="tab-btn${i ? "" : " active"}" role="tab" aria-selected="${i ? "false" : "true"}" data-tab="${t}">${SEC[t]}</button>`).join("");
    $("admin-nav").addEventListener("click", (e) => { const b = e.target.closest(".tab-btn"); if (b) { delete $("panel").dataset.wedding; show(b.dataset.tab); } });
    $("sign-out").addEventListener("click", () => { WS.clear(); location.replace("/signin.html"); });

    const panel = $("panel");
    panel.addEventListener("click", async (e) => {
      const fill = e.target.closest("[data-manual-prefill]");
      if (fill) {
        const { action, values } = JSON.parse(fill.dataset.manualPrefill);
        const details = panel.querySelector(`details[data-manual-panel="${action}"]`);
        const form = details?.querySelector("form");
        if (!form) return;
        form.reset();
        for (const field of manualFields[action]) {
          const input = form.elements.namedItem(field);
          if (input?.type === "checkbox") input.checked = false;
          else if (input && field !== "key") input.value = "";
        }
        form.dataset.keyContext = `${action}:${values.id || values.custody || ""}:${values.action || ""}`;
        if (action === "review-intent") form.dataset.wedding = (cache.manualWorkspace?.intents || []).find(i => i.id === values.id)?.wedding_id || "";
        if (form.elements.namedItem("key")) form.elements.namedItem("key").value = manualKey(form.dataset.keyContext);
        details.open = true;
        for (const [name, value] of Object.entries(values)) if (form.elements.namedItem(name)) {
          const input = form.elements.namedItem(name);
          if (!input.dataset.setupMoney) input.value = String(value ?? "");
        }
        form.dispatchEvent(new Event("manual-prefilled"));
        for (const [name, value] of Object.entries(values)) if (form.elements.namedItem(name)?.dataset.setupMoney) {
          manualSetup.prefillSetupValue(form.elements.namedItem(name), value);
        }
        form.elements.confirmed.checked = false;
        details.scrollIntoView({ block: "start" });
        ([...form.querySelectorAll("input[required]:not([type=checkbox])")].find(i => !i.value) || form.elements.confirmed).focus();
        toast("Form prepared. Review every field and confirm; nothing has been recorded.");
        return;
      }
      if (e.target.closest("#referral-older")) {
        const button = e.target.closest("#referral-older");
        button.disabled = true;
        try {
          const ledger = await get("referral-ledger", "&before=" + encodeURIComponent(button.dataset.before));
          $("referral-older-entries").textContent += JSON.stringify(ledger.entries, null, 2) + "\n";
          if (ledger.entries.length === 100) { button.dataset.before = ledger.entries.at(-1).id; button.disabled = false; }
        } catch (error) { toast(error.message, true); button.disabled = false; }
        return;
      }
      if (e.target.closest("#paystack-revoke")) {
        if (!confirm("Revoke Paystack live approval? New guest and publication payments stop. Existing payments still reconcile unless the independent reconciliation switch is off.")) return;
        try { await post("paystack-policy", { approved: false, confirmed: true, policyRevision: $("paystack-mode-form").elements.policyRevision.value }); await show("fees"); }
        catch (error) { toast(error.message, true); }
        return;
      }
      if (e.target.closest("#daraja-check")) {
        const out = $("daraja-readiness");
        out.textContent = "Checking…";
        try {
          const r = await get("daraja-readiness", "&health=1");
          const yn = v => v === true ? "yes" : v === false ? "NO" : "unknown";
          out.textContent = `Environment: ${r.configuredEnvironment}. Mode live: ${yn(r.modeIsLive)}; production: ${yn(r.environmentIsProduction)}; shortcode format valid: ${yn(r.shortcodeFormatValid)}; confirmation matches: ${yn(r.shortcodeConfirmationMatches)}; credentials present: ${yn(r.credentialsPresent.consumerKey && r.credentialsPresent.consumerSecret && r.credentialsPresent.passkey)}; kill switch on: ${yn(r.killSwitchOn)}; Owner approved: ${yn(r.ownerApproved)}; OAuth health: ${r.health.checked ? yn(r.health.healthy) : "not checked (credentials not configured for production)"}. Public origin secure: ${yn(r.callback.originSecure)}. Payouts: off.`;
        } catch (err) { out.textContent = ""; toast(err.message, true); }
        return;
      }
      if (e.target.closest("#daraja-revoke")) {
        if (!confirm("Revoke live M-Pesa approval? New live collection stops; already-admitted payments are still reconciled.")) return;
        try { await post("daraja-approval", { approved: false }); toast("Live approval revoked."); await show("fees"); } catch (err) { toast(err.message, true); }
        return;
      }
      if (e.target.closest("[data-ops-wedding]")) { panel.dataset.wedding = e.target.closest("[data-ops-wedding]").dataset.opsWedding; return show("weddings"); }
      if (e.target.closest("[data-wm]")) { panel.dataset.wedding = e.target.closest("[data-wm]").dataset.wm; return show("weddings"); }
      if (e.target.closest("[data-wm-back]")) { delete panel.dataset.wedding; return show("weddings"); }
      const t = e.target.closest("button[data-wa],button[data-ps],button[data-setrole],button[data-refund-id],button[data-refund-event]");
      if (!t) return;
      try {
        if (t.dataset.wa) {
          if (["archive", "unpublish"].includes(t.dataset.wa)) {
            panel.querySelector("#restriction-form")?.remove();
            panel.insertAdjacentHTML("afterbegin", `<form id="restriction-form" data-id="${esc(t.dataset.id)}" data-action="${esc(t.dataset.wa)}" class="card">
              <h3>${esc(t.dataset.wa)} wedding: Client-visible explanation</h3>
              <label>Category<select name="reason_code">${["content_policy", "inaccurate_details", "payment_issue", "legal_request", "safety", "other"].map(v => `<option>${v}</option>`).join("")}</select></label>
              <label>Reason<textarea name="reason" minlength="15" maxlength="1000" required></textarea></label>
              <label>What must the Client correct?<textarea name="required_action" minlength="10" maxlength="1000" required></textarea></label>
              <button type="submit" class="mini">Confirm restriction</button></form>`);
            $("restriction-form").scrollIntoView();
            return;
          }
          if (!confirm("Confirm: " + t.dataset.wa.replace("_", " ") + " this wedding?")) return;
          await post("wedding-action", { wedding_id: t.dataset.id, action: t.dataset.wa });
        } else if (t.dataset.ps) {
          if (!confirm("Confirm: mark payout as " + t.dataset.ps + "?")) return;
          const note = t.dataset.ps === "cancelled" ? prompt("Explain why this payout is cancelled and what the Client should correct (10-240 characters):") : null;
          if (t.dataset.ps === "cancelled" && note === null) return;
          await post("payout-status", { payout_id: t.dataset.id, status: t.dataset.ps, note });
        } else if (t.dataset.refundId) {
          const allocation = panel.querySelector(`select[data-refund-allocation="${t.dataset.refundId}"]`)?.value;
          if (!allocation || !confirm(`Record this provider-confirmed refund using the ${allocation} allocation? This does not initiate a refund.`)) return;
          await post("refund-resolution", { adjustment_id: t.dataset.refundId, allocation, confirmed: true });
        } else if (t.dataset.refundEvent) {
          const input = panel.querySelector(`input[data-refund-match-contribution="${t.dataset.refundEvent}"]`);
          const contributionId = input?.value.trim();
          if (!contributionId || !confirm("Match this signed provider refund to the contribution ID? This reserves the amount for review and does not initiate a refund.")) return;
          await post("refund-match", { event_id: Number(t.dataset.refundEvent), contribution_id: contributionId, confirmed: true });
        } else {
          const id = t.dataset.setrole;
          const sel = panel.querySelector(`select[data-role-for="${id}"]`);
          if (!confirm("Change this user's role to " + sel.value + "?")) return;
          await post("set-role", { user_id: id, role: sel.value });
        }
        toast("Saved.");
        show(panel.dataset.tab);
      } catch (err) { toast(err.message, true); }
    });
    panel.addEventListener("submit", async (e) => {
      if (e.target.matches("[data-manual-policy]")) {
        e.preventDefault();
        const form = e.target;
        if (!form.elements.confirmed.checked) return;
        let changes = { enabled: form.dataset.manualPolicy === "activate" };
        try {
        if (form.dataset.manualPolicy === "draft") {
          for (const field of ["custody_id", "review_evidence", "fee_evidence", "rail_evidence", "secure_evidence"]) {
            changes[field] = manualSetup.readSetupValue(form, field) || null;
          }
          const recipients = manualSetup.readSetupValue(form, "recipient_ids");
          changes.recipient_ids = Array.isArray(recipients) ? recipients : recipients.split(",").map(v => v.trim()).filter(Boolean);
          changes.fee_payer = form.elements.fee_payer.value.trim() || null;
          for (const field of ["per_payout_minor", "daily_minor", "payout_fee_minor", "statement_max_age_minutes"]) {
            const value = manualSetup.readSetupValue(form, field);
           changes[field] = value === "" || value === null ? null : Number(value);
          }
        }
          } catch (error) { toast(error.message, true); return; }
        const button = form.querySelector("button");
        button.disabled = true;
        try {
          await post("manual-payout-policy", { revision: form.dataset.revision, changes, confirmed: true });
          toast("Manual policy revision recorded. No transfer or automatic policy change.");
          await show("payouts");
        } catch (error) { toast(error.message, true); button.disabled = false; }
        return;
      }
      if (e.target.matches("[data-manual-action]")) {
        e.preventDefault();
        const form = e.target, action = form.dataset.manualAction;
        let body;
        try {
        body = Object.fromEntries(manualFields[action].map(key => {
          const value = manualSetup.readSetupValue(form, key);
          return [key, key === "owner_solo" ? form.elements[key]?.checked === true : manualNumbers.has(key) ? value === "" || value === null ? null : Number(value) : value || null];
        }));
        } catch (error) { toast(error.message, true); return; }
        if (action === "review-intent" && body.decision === "declined") {
          for (const key of ["key", "custody", "recipient", "fee"]) body[key] = null;
          body.owner_solo = false;
        }
        body.confirmed = form.elements.confirmed.checked;
        if (!body.confirmed) return;
        const button = form.querySelector("button");
        if (button.disabled) return;
        button.disabled = true;
        try {
          const result = await post("manual-payout-" + action, body);
          manualResult = `Manual ${action} recorded: ${result.result === null ? "declined; no reservation" : String(result.result)}. No transfer was initiated.`;
          manualKeys.delete(form.dataset.keyContext);
          toast(manualResult);
          await show("payouts");
        } catch (error) { toast(error.message, true); button.disabled = false; }
        return;
      }
      if (e.target.id === "referral-policy-form") {
        e.preventDefault();
        const form = e.target, button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const enabled = form.elements.enabled.checked;
          await post("referral-policy-save", {
            enabled, rateBasisPoints: enabled ? Math.round(Number(form.elements.percent.value) * 100) : 0,
            revision: form.dataset.revision, confirmed: form.elements.confirmed.checked
          });
          await show("referrals");
          toast("Referral policy saved. All estimates remain held and unpayable.");
        } catch (error) { toast(error.message, true); button.disabled = false; }
        return;
      }
      if (e.target.id === "default-currency-form") {
        e.preventDefault();
        const currency = e.target.elements.currency.value || null;
        const confirmation = currency
          ? `Set ${currency} as the default for new wedding drafts and public indicative FX display? Existing weddings and all USD-based fees and historical records remain unchanged.`
          : "Clear the platform default? New drafts will return to the USD legacy fallback. Existing weddings, fees and historical records remain unchanged.";
        if (!confirm(confirmation)) return;
        const button = e.target.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          await post("default-currency-save", { currency, confirmed: true });
          toast("Platform default currency saved.");
          await show("fees");
        } catch (error) { toast(error.message, true); button.disabled = false; }
        return;
      }
      e.preventDefault();
      if (["paystack-policy-form","paystack-mode-form","paystack-destination-form","paystack-settlement-form"].includes(e.target.id) ||
          e.target.classList.contains("paystack-publication-resolution")) {
        const form = e.target, button = form.querySelector('button[type="submit"]');
        if (button.disabled || !confirm("Confirm this Paystack configuration or read-only verification? No provider financial operation is initiated.")) return;
        button.disabled = true;
        const values = Object.fromEntries(new FormData(form));
        try {
          const action = form.classList.contains("paystack-publication-resolution") ? "paystack-publication-resolution"
            : form.id === "paystack-policy-form" ? "paystack-policy"
            : form.id === "paystack-mode-form" ? "paystack-settlement-mode"
            : form.id === "paystack-destination-form" ? "paystack-destination" : "paystack-settlement";
          const body = action === "paystack-policy" ? {
            approved: true, capabilities: JSON.parse(values.capabilities), feeBearer: values.feeBearer,
            standardEnabled: values.standardEnabled === "on", policyRevision: values.policyRevision,
            splitEnabled: values.splitEnabled === "on", publicationEnabled: values.publicationEnabled === "on",
            eligibilityConfirmed: values.eligibilityConfirmed === "on"
          } : { ...values, ...(action === "paystack-publication-resolution" ? { eventId: form.dataset.event } : {}) };
          await post(action, { ...body, confirmed: true });
          toast("Paystack configuration or verification saved.");
          await show("fees");
        } catch (error) { toast(error.message, true); button.disabled = false; }
        return;
      }
      if (e.target.id === "restriction-form" || e.target.dataset.moderationReview) {
        const form = e.target, button = form.querySelector('button[type="submit"]');
        if (button.disabled) return;
        const values = Object.fromEntries(new FormData(form));
        if (form.dataset.moderationReview && !confirm("Confirm this moderation review decision?")) return;
        button.disabled = true;
        try {
          if (form.id === "restriction-form") await post("wedding-action", { wedding_id: form.dataset.id, action: form.dataset.action, ...values });
          else await post("moderation-review", { case_id: form.dataset.moderationReview, expected_revision: Number(form.dataset.revision), ...values, confirmed: true });
          toast("Saved.");
          await show(panel.dataset.tab);
        } catch (error) { toast(error.message, true); button.disabled = false; }
        return;
      }
      if (e.target.id === "user-search") { panel.dataset.search = $("user-q").value.trim(); return show("users"); }
      if (e.target.id === "fees-form") {
        const n = (id) => (panel.querySelector("#" + id) ? Number(panel.querySelector("#" + id).value) : undefined);
        const mn = (id) => { const v = n(id); return v === undefined || Number.isNaN(v) ? undefined : Math.round(v * 100); };
        const policies = {
          publication_fee_minor: mn("p-fee"),
          far_future_months: n("p-ff-months"),
          far_future_fee_minor: mn("p-ff-fee"),
          free_publications_per_client: n("p-free"),
          contribution_fee_basis_points: Math.round(n("p-percent") * 100),
          contribution_fixed_fee_minor: mn("p-fixed-fee"),
          contribution_fixed_fee_currency: panel.querySelector("#p-fixed-currency")?.value.trim().toUpperCase(),
          max_contribution_minor: mn("p-max"),
          min_payout_minor: mn("p-min-payout"),
          max_payout_minor: mn("p-max-payout"),
          payout_hold_days: n("p-hold-days")
        };
        for (const k of Object.keys(policies)) if (policies[k] === undefined || Number.isNaN(policies[k])) delete policies[k];
        try { await post("policies-save", { policies }); toast("Settings saved."); } catch (err) { toast(err.message, true); }
      }
      if (e.target.id === "refund-policy-form") {
        const allocation = $("refund-allocation").value;
        if (!confirm(`Apply the ${allocation} refund-fee policy to new payments? Existing transactions keep their saved policy.`)) return;
        try {
          await post("refund-policy-save", { allocation, confirmed: true });
          toast("Refund allocation policy saved.");
          await show("fees");
        } catch (err) { toast(err.message, true); }
      }
      if (e.target.id === "daraja-approval-form") {
        if (!confirm("Approve LIVE M-Pesa collection? Guests may be charged REAL money once the kill switch is on. Payouts stay off and funds are held.")) return;
        try {
          await post("daraja-approval", { approved: true, confirmed: true });
          toast("Live approval granted. The environment kill switch is still a separate step.");
          await show("fees");
        } catch (err) { toast(err.message, true); }
        return;
      }
      if (e.target.id === "payment-controls-form") {
        const enabled = [...e.target.querySelectorAll('input[name="payment-provider"]:checked')].map(input => input.value);
        if (!confirm("Apply these methods to new checkouts? Existing payments remain with their original provider. This does not enable live payments.")) return;
        try {
          await post("payment-controls-save", { enabled, confirmed: true });
          toast("Payment methods saved.");
          await show("fees");
        } catch (err) { toast(err.message, true); }
      }
    });
    document.addEventListener("weddingsitefxchange", () => {
      if ($("panel").dataset.tab === "overview" && role !== "admin") show("overview");
    });
    show(tabs[0]);
  }
  window.BO = { init };
})();
