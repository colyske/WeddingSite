// Shared back-office UI for admin.html and owner.html. All data comes from /api/admin (role-checked server-side).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => WS.esc(s);
  const SEC = { overview: "Overview", weddings: "Weddings", users: "Users & roles", fees: "Fees & settings", ledger: "Ledger", payouts: "Payouts", audit: "Audit log", security: "Security" };
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

  const panels = {
    async overview(el) {
      const o = await get("overview");
      el.innerHTML = `<h2>Platform overview</h2><div class="stats">
        ${stat("Weddings", o.weddings)}${stat("Published", o.published)}${stat("Archived", o.archived)}${stat("Past / completed", o.past)}
        ${stat("Users", o.users)}${stat("Staff", o.admins)}${stat("RSVPs", o.rsvps)}${stat("DJ bids", o.bids)}
        ${stat("Pending payouts", o.pending_payouts)}${stat("Test payments", o.test_payments)}</div>
        <div class="stats">${stat("Contributions collected", esc(moneyMap(o.collected_by_currency)))}
        ${stat("Platform fees (contributions)", esc(moneyMap(o.fees_by_currency)))}
        ${stat("Publication fees", esc(moneyMap(o.publication_fees_by_currency)))}</div>
        <p class="fine">Payments are processed in <strong>test mode</strong>; amounts labelled test-simulator are not real money.</p>`;
    },
    async weddings(el) {
      const { weddings } = await get("weddings");
      const rows = weddings.map((w) => {
        const state = w.archived_at ? "Archived" : w.is_past ? "Completed" : w.published_at ? "Published" : "Draft";
        const acts = [
          w.published_at && !w.archived_at ? btn("Unpublish", `data-wa="unpublish" data-id="${esc(w.id)}"`) : "",
          w.archived_at ? btn("Restore", `data-wa="restore" data-id="${esc(w.id)}"`) : btn("Archive", `data-wa="archive" data-id="${esc(w.id)}"`),
          w.fee_status !== "paid" && w.fee_status !== "waived" ? btn("Waive fee", `data-wa="waive_fee" data-id="${esc(w.id)}"`) : "",
          w.slug && w.published_at ? `<a class="mini" href="/guest.html?slug=${encodeURIComponent(w.slug)}" target="_blank" rel="noopener">Guest site</a>` : ""
        ].join(" ");
        return `<tr><td>${esc(w.couple_names)}</td><td>${esc(w.owner_email || "-")}</td><td>${esc(w.wedding_date || "-")} ${esc(w.time_zone || "")}</td>
          <td>${state}</td><td>${w.rsvps}/${w.bids}</td><td>${esc(WS.money(Number(w.collected_minor), w.currency, false))}</td>
          <td>${esc(w.fee_status)}</td><td>${w.kyc_complete ? "Complete" : "Missing"}</td><td class="acts">${acts}</td></tr>`;
      });
      el.innerHTML = `<h2>All weddings</h2><p class="fine">Weddings are never deleted: they can only be unpublished or archived (reversible).</p>` +
        table(["Couple", "Owner", "Date / zone", "State", "RSVPs/Bids", "Collected", "Pub. fee", "KYC", "Actions"], rows);
    },
    async users(el) {
      const search = el.dataset.search || "";
      const { users } = await get("users", search ? "&search=" + encodeURIComponent(search) : "");
      const canRole = role === "owner" || role === "superadmin";
      const me = WS.session().user?.id;
      const rows = users.map((u) => {
        const sel = canRole && u.id !== me && u.platform_role !== "owner"
          ? `<select data-role-for="${esc(u.id)}" aria-label="Role for ${esc(u.email)}">${["client", "admin", "superadmin"].map((r) => `<option value="${r}"${r === u.platform_role ? " selected" : ""}>${r}</option>`).join("")}</select> ${btn("Apply", `data-setrole="${esc(u.id)}"`)}`
          : esc(u.platform_role);
        return `<tr><td>${esc(u.email || "-")}</td><td>${esc(u.display_name || "-")}</td><td>${sel}</td><td>${u.wedding_count}</td><td>${date(u.created_at)}</td></tr>`;
      });
      el.innerHTML = `<h2>Users & roles</h2>
        <form id="user-search" class="inline"><input type="search" id="user-q" placeholder="Search email or name" value="${esc(search)}"><button type="submit" class="mini">Search</button></form>
        ${canRole ? '<p class="fine">Role changes are audited. You cannot change your own role. SuperAdmins can only manage Admin/Client; only the Owner can promote to SuperAdmin.</p>' : '<p class="fine">Only the Owner or a SuperAdmin can change roles.</p>'}` +
        table(["Email", "Name", "Role", "Weddings", "Joined"], rows);
    },
    async fees(el) {
      const { policies: p } = await get("policies");
      const f = (id, label, val, hint) => `<label for="${id}">${esc(label)}</label><input id="${id}" type="number" min="0" step="1" value="${esc(val ?? "")}"><span class="fine">${esc(hint)}</span>`;
      const full = role === "owner" || role === "superadmin";
      el.innerHTML = `<h2>Fees & settings</h2>
        <p class="fine"><strong>How publication fees combine:</strong> (1) a paid or waived fee is never charged twice; (2) if the wedding date is further away than the far-future threshold, the far-future fee applies (this overrides the free allowance); (3) otherwise the client's first N published weddings are free; (4) after that the standard per-wedding fee applies. Amounts are in minor units (cents).</p>
        <form id="fees-form">
        ${f("p-fee", "Standard publication fee (minor units)", p.publication_fee_minor, "Charged after the free allowance is used.")}
        ${f("p-ff-months", "Far-future threshold (months)", p.far_future_months, "Weddings further away than this are charged the far-future fee.")}
        ${f("p-ff-fee", "Far-future fee (minor units)", p.far_future_fee_minor, "Applies before the free allowance.")}
        ${f("p-free", "Free publications per client", p.free_publications_per_client, "First N published weddings per client are free.")}
        ${f("p-bps", "Contribution fee (basis points)", p.contribution_fee_basis_points, "250 = 2.5% of each contribution.")}
        ${full ? f("p-max", "Max single contribution (minor units)", p.max_contribution_minor, "Safety cap per payment.") : ""}
        <button type="submit">Save settings</button></form>`;
    },
    async ledger(el) {
      const { ledger } = await get("ledger");
      el.innerHTML = `<h2>Ledger</h2><p class="fine">Newest 200 contributions across all weddings. test-simulator rows are simulated.</p>` +
        table(["Date", "Wedding", "Stream", "Amount", "Fee", "Net", "Status", "Provider"], ledger.map((l) =>
          `<tr><td>${date(l.created_at)}</td><td>${esc(l.couple_names)}</td><td>${esc(l.stream_name)}</td><td>${esc(WS.money(Number(l.amount_minor), l.currency, false))}</td><td>${esc(WS.money(Number(l.fee_minor || 0), l.currency, false))}</td><td>${esc(WS.money(Number(l.net_minor || 0), l.currency, false))}</td><td>${esc(l.status)}</td><td>${esc(l.provider || "-")}</td></tr>`));
    },
    async payouts(el) {
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
      el.innerHTML = `<h2>Audit log</h2>` + table(["When", "Actor", "Action", "Table"], audit.map((a) =>
        `<tr><td>${date(a.created_at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.table_name || "")}</td></tr>`));
    },
    async security(el) {
      el.innerHTML = `<h2>Security guidance</h2><ul class="guide">
        <li>Use a unique password of 12+ characters for the Owner account and rotate it if it was ever shared.</li>
        <li>Owner is the only role that can promote SuperAdmins; keep at least one trusted SuperAdmin as backup.</li>
        <li>ID/passport numbers are stored privately and masked; only staff can reveal them and each reveal is audited.</li>
        <li>MFA enrolment is not built into WeddingSite yet: enable MFA on the email account used for recovery.</li>
        <li>Payments are in test mode until live provider credentials are configured by the Owner in the hosting environment.</li>
        <li>Review the audit log regularly for unexpected role changes or fee waivers.</li></ul>`;
    }
  };

  async function show(tab) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
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
    const tabs = opts.ownerOnly ? ["overview", "users", "fees", "ledger", "payouts", "audit", "weddings", "security"] : ["overview", "weddings", "users", "fees", "ledger", "payouts", "audit"];
    $("admin-nav").innerHTML = tabs.map((t, i) => `<button type="button" class="tab-btn${i ? "" : " active"}" data-tab="${t}">${SEC[t]}</button>`).join("");
    $("admin-nav").addEventListener("click", (e) => { const b = e.target.closest(".tab-btn"); if (b) show(b.dataset.tab); });
    $("sign-out").addEventListener("click", () => { WS.clear(); location.replace("/signin.html"); });

    const panel = $("panel");
    panel.addEventListener("click", async (e) => {
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
        const policies = { publication_fee_minor: n("p-fee"), far_future_months: n("p-ff-months"), far_future_fee_minor: n("p-ff-fee"), free_publications_per_client: n("p-free"), contribution_fee_basis_points: n("p-bps"), max_contribution_minor: n("p-max") };
        for (const k of Object.keys(policies)) if (policies[k] === undefined || Number.isNaN(policies[k])) delete policies[k];
        try { await post("policies-save", { policies }); toast("Settings saved."); } catch (err) { toast(err.message, true); }
      }
    });
    show("overview");
  }
  window.BO = { init };
})();
