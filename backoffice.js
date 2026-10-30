// Shared back-office UI for admin.html and owner.html. All data comes from /api/admin (role-checked server-side).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => WS.esc(s);
  const SEC = { overview: "Overview", operations: "Operations", weddings: "Weddings", users: "Users & roles", fees: "Fees & settings", ledger: "Ledger", payouts: "Payouts", audit: "Audit log", security: "Security" };
  let role = "";
  let cache = {};

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
        ${extendedPolicy ? `${f("p-fixed-fee", "Optional fixed commission", p.contribution_fixed_fee_minor, "Also deducted per verified payment when its currency matches the currency below.")}<label for="p-fixed-currency">Fixed commission currency</label><input id="p-fixed-currency" type="text" minlength="3" maxlength="3" pattern="[A-Za-z]{3}" value="${esc(p.contribution_fixed_fee_currency || "USD")}" required><span class="fine">Three-letter ISO currency code; fixed commission is not applied in other currencies.</span>` : '<p class="fine">Fixed commission and settlement-hold controls will appear after the financial policy migration is validated and applied.</p>'}
        ${f("p-max", "Max single contribution", p.max_contribution_minor, "Safety cap per payment.")}
        ${f("p-max-payout", "Maximum withdrawal", p.max_payout_minor, "Per-request limit; available balance and holds are checked separately.")}
        ${extendedPolicy ? `${f("p-min-payout", "Minimum withdrawal", p.min_payout_minor, "Minimum eligible net balance required for a withdrawal request.")}${g("p-hold-days", "Settlement hold (days)", p.payout_hold_days, "Funds remain unavailable until this hold and provider settlement are satisfied.")}` : ""}
        <button type="submit"${owner ? "" : " disabled"}>${owner ? "Save settings" : "Owner access required"}</button></fieldset></form>
        <p class="fine">Only the protected Owner can change platform fee and payout policies. SuperAdmins can view these settings; regular Admins cannot access them. Transaction eligibility and fee calculation are enforced server-side.</p>
        ${extendedPolicy ? `<details><summary>Recent policy versions (${history.length})</summary>${history.length ? history.map((h) => `<article class="policy-version"><strong>${date(h.changed_at)}</strong><pre>${esc(JSON.stringify({ old: h.old_values, new: h.new_values }, null, 2))}</pre></article>`).join("") : '<p class="fine">No policy changes have been recorded yet.</p>'}</details>` : ""}`;
      const refundAllocation = refundPolicy.allocation || "manual_review";
      const providerLabels = { daraja: "M-Pesa — Daraja (sandbox unless Owner-approved live collection is enabled)", paystack: "Card — Paystack test", stripe: "Card — Stripe test" };
      el.insertAdjacentHTML("beforeend", `<form id="payment-controls-form"><h3>Enabled payment methods</h3>
        <p class="fine">SuperAdmin and Owner controls for new checkouts across all weddings. Enabling a switch never enables live mode or supplies missing credentials. Pending payments remain with their original provider and can still be verified.</p>
        ${(paymentControls.providers || []).map(provider => `<label><input type="checkbox" name="payment-provider" value="${esc(provider.id)}"${(paymentControls.enabled || []).includes(provider.id) ? " checked" : ""}>
          ${esc(providerLabels[provider.id] || provider.id)} — ${provider.configured ? "Test adapter configured (health checked at checkout)" : "Setup incomplete or unsupported currency/market"}</label>`).join("")}
        <button type="submit">Save payment methods</button></form>`);
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
      const { payouts } = await get("payouts");
      el.innerHTML = `<h2>Payouts / withdrawals</h2><p class="fine">Complete KYC to receive your payout. Both partners' required details and consent must be submitted before requesting, approving or marking a payout sent; this is not independent identity verification. Four-eyes rule: you cannot approve a payout you requested. No money moves automatically; "sent" records a manual transfer.</p>` +
        table(["Requested", "Wedding", "Amount", "Status", "Note", "Actions"], payouts.map((p) => {
          const acts = [];
          if (p.status === "requested") acts.push(btn("Approve", `data-ps="approved" data-id="${esc(p.id)}"`), btn("Cancel", `data-ps="cancelled" data-id="${esc(p.id)}"`));
          if (p.status === "approved") acts.push(btn("Mark sent", `data-ps="sent" data-id="${esc(p.id)}"`), btn("Cancel", `data-ps="cancelled" data-id="${esc(p.id)}"`));
          return `<tr><td>${date(p.requested_at)}</td><td>${esc(p.couple_names)} <a href="/wedding.html?id=${encodeURIComponent(p.wedding_id)}#kyc-section">KYC details</a></td><td>${esc(WS.money(Number(p.amount_minor), p.currency, false))}</td><td>${esc(p.status)}</td><td>${esc(p.note || "")}</td><td class="acts">${acts.join(" ") || "-"}</td></tr>`;
        }));
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
        <li>Payments are in test mode unless the Owner has enabled live M-Pesa collection (an environment kill switch plus Owner approval). Live funds are held and payouts stay disabled.</li>
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
    const tabs = role === "admin" ? ["operations", "weddings", "users"] : ["overview", "operations", "weddings", "users", "fees", "ledger", "payouts", "audit", "security"];
    $("admin-nav").innerHTML = tabs.map((t, i) => `<button type="button" class="tab-btn${i ? "" : " active"}" role="tab" aria-selected="${i ? "false" : "true"}" data-tab="${t}">${SEC[t]}</button>`).join("");
    $("admin-nav").addEventListener("click", (e) => { const b = e.target.closest(".tab-btn"); if (b) { delete $("panel").dataset.wedding; show(b.dataset.tab); } });
    $("sign-out").addEventListener("click", () => { WS.clear(); location.replace("/signin.html"); });

    const panel = $("panel");
    panel.addEventListener("click", async (e) => {
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
      e.preventDefault();
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
