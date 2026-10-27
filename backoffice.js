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
    return keys.length ? keys.map((c) => WS.money(Number(obj[c]), c, false)).join(" · ") : "0";
  };
  const date = (v) => (v ? new Date(v).toLocaleString() : "-");
  const stat = (label, value) => `<div class="stat-card"><h3>${esc(label)}</h3><div class="number">${value}</div></div>`;
  const table = (head, rows) =>
    rows.length
      ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
      : '<p class="empty">Nothing here yet.</p>';
  const btn = (label, attrs) => `<button type="button" class="mini" ${attrs}>${esc(label)}</button>`;

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
      const o = await get("overview");
      el.innerHTML = `<h2>Platform overview</h2><div class="stats">
        ${stat("Weddings", o.weddings)}${stat("Published", o.published)}${stat("Archived", o.archived)}${stat("Past / completed", o.past)}
        ${stat("Users", o.users)}${stat("Staff", o.admins)}${stat("RSVPs", o.rsvps)}${stat("DJ bids", o.bids)}
        ${stat("Pending payouts", o.pending_payouts)}${stat("Test payments", o.test_payments)}</div>
        <div class="stats">${stat("Contributions collected", esc(moneyMap(o.collected_by_currency)))}
        ${stat("Platform fees (contributions)", esc(moneyMap(o.fees_by_currency)))}
        ${stat("Known provider charges", esc(moneyMap(o.provider_fees_by_currency)))}
        ${stat("Couple net, before withdrawals", esc(moneyMap(o.net_to_weddings_by_currency)))}
        ${stat("Held pending provider fee", esc(moneyMap(o.provider_fee_holds_by_currency)))}
        ${stat("Publication fees", esc(moneyMap(o.publication_fees_by_currency)))}</div>
        <p class="fine">Checkout only accepts verified test-provider payments. Test checkout remains unavailable until provider keys, allowed currencies and markets, Turnstile site/secret keys, and a wedding-specific provider configuration are all ready. Payment credentials are never shown here.</p>`;
    },
    async operations(el) {
      const { queue: q } = await get("operations");
      const reviews = q.payment_reviews || [];
      const kyc = q.kyc_exceptions || [];
      const reconciliations = q.reconciliations || [];
      const payouts = q.payouts || [];
      if (role === "owner") {
        const counts = q.counts || {};
        el.innerHTML = `<h2>Operational health</h2><p class="fine">Routine exception work is assigned to Admins. The Owner view is limited to aggregate escalations; no private KYC values are shown.</p>
          <div class="stats">${stat("Paid actions needing follow-up", counts.payment_reviews ?? 0)}${stat("KYC exceptions", counts.kyc_exceptions ?? 0)}
          ${stat("Reconciliation differences", counts.reconciliations ?? 0)}${stat("Payouts awaiting staff action", counts.payouts ?? 0)}</div>`;
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
      el.innerHTML = `<h2>Admin exception queue</h2><p class="fine">Work unresolved exceptions first. Paid action failures do not authorize a second charge; reconcile the verified payment before any manual fulfilment. KYC completeness is not independent identity verification.</p>
        <h3>Paid actions needing follow-up (${reviews.length})</h3>${table(["Detected", "Wedding", "Reason", "Next step"], reviewRows)}
        <h3>KYC completeness exceptions (${kyc.length})</h3>${table(["Wedding", "Date", "Next step"], kycRows)}
        <h3>Reconciliation differences (${reconciliations.length})</h3>${table(["Detected", "Wedding", "Provider", "Expected", "Reported", "Status"], reconRows)}
        <h3>Payouts awaiting staff action (${payouts.length})</h3>${table(["Requested", "Wedding", "Amount", "Status"], payoutRows)}
        <p class="fine">Provider disputes/refunds and automated payout execution are unavailable until provider integration and settlement operations are configured. Do not mark an exception resolved from this screen.</p>`;
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
            w.slug && w.published_at ? `<a class="mini" href="/guest.html?slug=${encodeURIComponent(w.slug)}" target="_blank" rel="noopener">Guest site</a>` : ""
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
      const canRole = role === "owner";
      const me = WS.session().user?.id;
      mountPaged(el, "users", {
        title: "Users & roles",
        intro: canRole ? "The protected Owner controls Admin/SuperAdmin delegation. Role changes are audited, and you cannot change your own role." : "Only the protected Owner can change platform roles.",
        head: ["Email", "Name", "Role", "Weddings", "Joined"],
        items: users,
        text: (u) => [u.email, u.display_name, u.platform_role].join(" "),
        row: (u) => {
          const sel = canRole && u.id !== me && u.platform_role !== "owner"
            ? `<select data-role-for="${esc(u.id)}" aria-label="Role for ${esc(u.email)}">${["client", "admin", "superadmin"].map((r) => `<option value="${r}"${r === u.platform_role ? " selected" : ""}>${r}</option>`).join("")}</select> ${btn("Apply", `data-setrole="${esc(u.id)}"`)}`
            : esc(u.platform_role);
          return `<tr><td>${esc(u.email || "-")}</td><td>${esc(u.display_name || "-")}</td><td>${sel}</td><td>${u.wedding_count}</td><td>${date(u.created_at)}</td></tr>`;
        }
      });
    },
    async fees(el) {
      const { policies: p } = await get("policies");
      const extendedPolicy = ["contribution_fixed_fee_minor", "contribution_fixed_fee_currency", "min_payout_minor", "payout_hold_days"]
        .every((key) => Object.prototype.hasOwnProperty.call(p, key));
      const { history = [] } = role === "owner" && extendedPolicy ? await get("policy-history") : {};
      const major = (v) => (v === null || v === undefined ? "" : (Number(v) / 100).toFixed(2));
      const f = (id, label, val, hint, max = "") => `<label for="${id}">${esc(label)}</label><input id="${id}" type="number" min="0" ${max ? `max="${max}"` : ""} step="0.01" value="${esc(major(val))}" required><span class="fine">${esc(hint)}</span>`;
      const g = (id, label, val, hint) => `<label for="${id}">${esc(label)}</label><input id="${id}" type="number" min="0" step="1" value="${esc(val ?? "")}" required><span class="fine">${esc(hint)}</span>`;
      const owner = role === "owner";
      const percent = (Number(p.contribution_fee_basis_points || 0) / 100).toFixed(2);
      el.innerHTML = `<h2>Fees & settings</h2>
        <p class="fine"><strong>How publication fees combine:</strong> (1) a paid or waived fee is never charged twice; (2) if the wedding date is further away than the far-future threshold, the far-future fee applies (this overrides the free allowance); (3) otherwise the client's first N published weddings are free; (4) after that the standard per-wedding fee applies.</p>
        <p class="fine"><strong>Units:</strong> money fields are entered and shown in major units with 2 decimals (e.g. <code>15.50</code> = 15 units and 50 cents). They are stored in minor units (<code>15.50 &times; 100 = 1550</code>) and use each wedding's own currency.</p>
        <p class="fine"><strong>Commission:</strong> this is deducted from the wedding's proceeds, not added as a guest surcharge. Each new transaction snapshots the policy; later changes do not reprice existing payments. Unknown provider charges are not guessed.</p>
        <form id="fees-form"><fieldset${owner ? "" : " disabled"}>
        ${f("p-fee", "Standard publication fee", p.publication_fee_minor, "Charged after the free allowance is used.")}
        ${g("p-ff-months", "Far-future threshold (months)", p.far_future_months, "Weddings further away than this are charged the far-future fee.")}
        ${f("p-ff-fee", "Far-future fee", p.far_future_fee_minor, "Applies before the free allowance.")}
        ${g("p-free", "Free publications per client", p.free_publications_per_client, "First N published weddings per client are free.")}
        <label for="p-percent">Platform commission (%)</label><input id="p-percent" type="number" min="0" max="100" step="0.01" value="${esc(percent)}" required><span class="fine">Deducted from each verified payment. Stored to the nearest 0.01% (basis points).</span>
        ${extendedPolicy ? `${f("p-fixed-fee", "Optional fixed commission", p.contribution_fixed_fee_minor, "Also deducted per verified payment when its currency matches the currency below.")}<label for="p-fixed-currency">Fixed commission currency</label><input id="p-fixed-currency" type="text" minlength="3" maxlength="3" pattern="[A-Za-z]{3}" value="${esc(p.contribution_fixed_fee_currency || "USD")}" required><span class="fine">Three-letter ISO currency code; fixed commission is not applied in other currencies.</span>` : '<p class="fine">Fixed commission and settlement-hold controls will appear after the financial policy migration is validated and applied.</p>'}
        ${f("p-max", "Max single contribution", p.max_contribution_minor, "Safety cap per payment.")}
        ${f("p-max-payout", "Maximum withdrawal", p.max_payout_minor, "Per-request limit; available balance and holds are checked separately.")}
        ${extendedPolicy ? `${f("p-min-payout", "Minimum withdrawal", p.min_payout_minor, "Minimum eligible net balance required for a withdrawal request.")}${g("p-hold-days", "Settlement hold (days)", p.payout_hold_days, "Funds remain unavailable until this hold and provider settlement are satisfied.")}` : ""}
        <button type="submit"${owner ? "" : " disabled"}>${owner ? "Save settings" : "Owner access required"}</button></fieldset></form>
        <p class="fine">Only the protected Owner can change platform fee and payout policies. Admins can view these settings; transaction eligibility and fee calculation are enforced server-side.</p>
        ${owner && extendedPolicy ? `<details><summary>Recent policy versions (${history.length})</summary>${history.length ? history.map((h) => `<article class="policy-version"><strong>${date(h.changed_at)}</strong><pre>${esc(JSON.stringify({ old: h.old_values, new: h.new_values }, null, 2))}</pre></article>`).join("") : '<p class="fine">No policy changes have been recorded yet.</p>'}</details>` : ""}`;
    },
    async ledger(el) {
      const { ledger } = await get("ledger");
      mountPaged(el, "ledger", {
        title: "Ledger",
        intro: "Newest 500 contributions across all weddings. test-simulator rows are simulated.",
        head: ["Date", "Wedding", "Stream", "Amount", "Fee", "Net", "Status", "Provider"],
        items: ledger,
        text: (l) => [l.couple_names, l.stream_name, l.status, l.provider].join(" "),
        row: (l) => `<tr><td>${date(l.created_at)}</td><td>${esc(l.couple_names)}</td><td>${esc(l.stream_name)}</td><td>${esc(WS.money(Number(l.amount_minor), l.currency, false))}</td><td>${esc(WS.money(Number(l.fee_minor || 0), l.currency, false))}</td><td>${esc(WS.money(Number(l.net_minor || 0), l.currency, false))}</td><td>${esc(l.status)}</td><td>${esc(l.provider || "-")}</td></tr>`
      });
    },    async payouts(el) {
      const { payouts } = await get("payouts");
      el.innerHTML = `<h2>Payouts / withdrawals</h2><p class="fine">Four-eyes rule: you cannot approve a payout you requested. No money moves automatically; "sent" records a manual transfer.</p>` +
        table(["Requested", "Wedding", "Amount", "Status", "Note", "Actions"], payouts.map((p) => {
          const acts = [];
          if (p.status === "requested") acts.push(btn("Approve", `data-ps="approved" data-id="${esc(p.id)}"`), btn("Cancel", `data-ps="cancelled" data-id="${esc(p.id)}"`));
          if (p.status === "approved") acts.push(btn("Mark sent", `data-ps="sent" data-id="${esc(p.id)}"`), btn("Cancel", `data-ps="cancelled" data-id="${esc(p.id)}"`));
          return `<tr><td>${date(p.requested_at)}</td><td>${esc(p.couple_names)}</td><td>${esc(WS.money(Number(p.amount_minor), p.currency, false))}</td><td>${esc(p.status)}</td><td>${esc(p.note || "")}</td><td class="acts">${acts.join(" ") || "-"}</td></tr>`;
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
        <li>MFA enrolment is not built into WeddingSite yet: enable MFA on the email account used for recovery.</li>
        <li>Payments are in test mode until live provider credentials are configured by the Owner in the hosting environment.</li>
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
    const tabs = opts.ownerOnly ? ["overview", "operations", "users", "fees", "ledger", "payouts", "audit", "weddings", "security"] : ["overview", "operations", "weddings", "users", "fees", "ledger", "payouts", "audit"];
    $("admin-nav").innerHTML = tabs.map((t, i) => `<button type="button" class="tab-btn${i ? "" : " active"}" role="tab" aria-selected="${i ? "false" : "true"}" data-tab="${t}">${SEC[t]}</button>`).join("");
    $("admin-nav").addEventListener("click", (e) => { const b = e.target.closest(".tab-btn"); if (b) { delete $("panel").dataset.wedding; show(b.dataset.tab); } });
    $("sign-out").addEventListener("click", () => { WS.clear(); location.replace("/signin.html"); });

    const panel = $("panel");
    panel.addEventListener("click", async (e) => {
      if (e.target.closest("[data-ops-wedding]")) { panel.dataset.wedding = e.target.closest("[data-ops-wedding]").dataset.opsWedding; return show("weddings"); }
      if (e.target.closest("[data-wm]")) { panel.dataset.wedding = e.target.closest("[data-wm]").dataset.wm; return show("weddings"); }
      if (e.target.closest("[data-wm-back]")) { delete panel.dataset.wedding; return show("weddings"); }
      const t = e.target.closest("button[data-wa],button[data-ps],button[data-setrole]");
      if (!t) return;
      try {
        if (t.dataset.wa) {
          if (!confirm("Confirm: " + t.dataset.wa.replace("_", " ") + " this wedding?")) return;
          await post("wedding-action", { wedding_id: t.dataset.id, action: t.dataset.wa });
        } else if (t.dataset.ps) {
          if (!confirm("Confirm: mark payout as " + t.dataset.ps + "?")) return;
          await post("payout-status", { payout_id: t.dataset.id, status: t.dataset.ps });
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
    });
    show("overview");
  }
  window.BO = { init };
})();
