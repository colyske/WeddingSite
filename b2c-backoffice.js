(function () {
  async function request(action, body) {
    const response = await WS.api("/api/b2c?action=" + action, body ? {
      method: "POST", body: JSON.stringify({ ...body, confirmed: true })
    } : undefined);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "B2C request failed.");
    return data;
  }
  const esc = value => WS.esc(String(value ?? ""));
  async function mount(el, owner = true) {
    const [{ policy, readiness }, { dispatches }] = await Promise.all([request(owner ? "readiness" : "controls"), request("status")]);
    el.innerHTML = `<h2>M-Pesa B2C payouts</h2>
      <p><strong>Default OFF.</strong> Collection approval does not approve payouts. KYC completeness is not identity verification.
      Transfers require independently reviewed recipient evidence, settled live Daraja funds, known fees, verified utility funding and deployment capability checks.</p>
      <p>Dispatch policy: <strong>${policy.dispatch_enabled ? "enabled" : "OFF"}</strong>.
      Approval: <strong>${policy.require_four_eyes ? "four-eyes required" : "explicit limited auto-approval"}</strong>.
      Deployment: <strong>${readiness.ready ? "prerequisites configured" : "held"}</strong>. Policy revision: ${esc(policy.revision)}.</p>
      <p>Missing deployment checks: ${esc(Object.entries(readiness.checks).filter(([, ready]) => !ready).map(([key]) => key).join(", ") || "none")}.
      Auto-approval deployment gate: ${readiness.autoApprovalGate ? "on" : "OFF"}.</p>
      <p><a href="docs/B2C-PAYOUTS.md">Activation prerequisites and official-document limitations</a>.
      No provider is contacted by this screen's readiness check. API contract confirmation is an independent deployment prerequisite.</p>
      <form id="b2c-policy"><h3>Owner-only approval policy</h3>
        <p>No scope or financial limits are preselected. Editing approval policy does not activate dispatch.</p>
        <label>Approval mode<select name="mode"><option value="human">Require four-eyes</option><option value="limited">Limited automatic approval (explicit scope required)</option></select></label>
        <label>Explicit limits JSON (minor KES units; per_payout_minor, daily_minor, wedding_ids)
          <textarea name="limits" rows="3" placeholder="No default limits"></textarea></label>
        <label>Audit reason<input name="reason" minlength="10" maxlength="240" required></label>
        <button type="submit">Save approval policy</button>
        <button type="button" id="b2c-stop">Stop new dispatch</button></form>
      <form id="b2c-recipient"><h3>Independent recipient review</h3>
        <p>Obtain the official inbound statement independently, match its receipt and payer MSISDN to a couple partner, and review identity ownership.
        A receipt ID or submitted KYC phone alone is insufficient. Never paste ID documents or credentials here.</p>
        <label>Wedding UUID<input name="weddingId" required></label>
        <label>Verified inbound contribution UUID<input name="contributionId" required></label>
        <label>Statement-proven MSISDN (254...)<input name="msisdn" pattern="254[17][0-9]{8}" required></label>
        <label>Secure statement evidence reference<input name="statementReference" minlength="10" maxlength="240" required></label>
        <label><input type="checkbox" name="reviewed" required> I independently checked the official statement and partner ownership.</label>
        <button type="submit">Record independent review</button></form>
      <h3>Reserved dispatches</h3><p>Timeouts and inconclusive evidence retain funds. Never retry an uncertain payout.
      Use an independent official statement to reconcile; transaction-status observations alone cannot prove recipient or amount.</p>
      <form id="b2c-dispatch"><label>Approved payout UUID<input name="payoutId" required></label>
        <label><input type="checkbox" required> I confirm dispatch of this approved payout, not a retry of an uncertain transfer.</label>
        <button type="submit"${policy.dispatch_enabled && readiness.ready ? "" : " disabled"}>Dispatch approved payout</button></form>
      <div class="table-wrap"><table><thead><tr><th>Payout</th><th>Dispatch</th><th>Amount</th><th>Status</th></tr></thead><tbody>
      ${dispatches.map(d => `<tr><td>${esc(d.payout_id)}</td><td>${esc(d.id)}</td><td>${esc(WS.money(Number(d.amount_minor), "KES", false))}</td><td>${esc(d.state)}</td></tr>`).join("")}
      </tbody></table></div>
      <form id="b2c-reconcile"><h3>Official statement reconciliation</h3>
        <label>Dispatch UUID<input name="dispatchId" required></label>
        <label>Statement evidence reference<input name="statementReference" minlength="10" maxlength="240" required></label>
        <label>Official outcome<select name="outcome"><option value="inconclusive">Inconclusive (retain funds)</option><option value="succeeded">Confirmed paid</option><option value="failed">Confirmed not paid</option></select></label>
        <label>Official transaction reference<input name="transactionId"></label>
        <label>Statement recipient MSISDN<input name="msisdn"></label>
        <label>Statement amount (minor KES units)<input name="amountMinor" type="number" min="1" step="1"></label>
        <button type="submit">Record independent reconciliation</button></form>
      <p id="b2c-notice" class="notice" role="status" aria-live="polite"></p>`;
    const notice = message => { el.querySelector("#b2c-notice").textContent = message; };
    el.querySelector("#b2c-policy").hidden = !owner;
    el.querySelector("#b2c-recipient").hidden = !owner;
    if (owner) {
      el.querySelector('#b2c-policy [name="mode"]').value = policy.require_four_eyes ? "human" : "limited";
      el.querySelector('#b2c-policy [name="limits"]').value = policy.auto_approval_limits ? JSON.stringify(policy.auto_approval_limits) : "";
    }
    const submit = (selector, action, fields) => {
      el.querySelector(selector).addEventListener("submit", async event => {
        event.preventDefault();
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const values = Object.fromEntries(new FormData(event.target));
          const result = await request(action, fields(values));
          await mount(el, owner);
          notice(result.state === "uncertain" ? "Outcome uncertain. Funds remain reserved; independent reconciliation is required. Do not retry."
            : result.state === "accepted" ? "Provider accepted the request. Funds remain reserved until verified final evidence."
              : "Saved and audited.");
        } catch (error) { notice(error.message); button.disabled = false; }
      });
    };
    submit("#b2c-policy", "policy-save", values => {
      const changes = { require_four_eyes: values.mode === "human" };
      if (values.mode === "limited") changes.auto_approval_limits = JSON.parse(values.limits);
      return { revision: policy.revision, changes, reason: values.reason };
    });
    submit("#b2c-recipient", "recipient-review", values => values);
    submit("#b2c-dispatch", "dispatch", values => ({ ...values, idempotencyKey: crypto.randomUUID() }));
    submit("#b2c-reconcile", "reconcile", values => ({ ...values, amountMinor: values.amountMinor ? Number(values.amountMinor) : null }));
    el.querySelector("#b2c-stop").addEventListener("click", async () => {
      try {
        await request("policy-save", { revision: policy.revision, changes: { dispatch_enabled: false }, reason: "Owner emergency stop of new B2C dispatch" });
        await mount(el, owner);
        notice("New dispatch stopped. Existing reservations remain held and callbacks can still reconcile.");
      } catch (error) { notice(error.message); }
    });
  }
  window.B2CBackoffice = { mount };
})();
