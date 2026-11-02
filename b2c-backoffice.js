(function () {
  const esc = value => WS.esc(String(value ?? ""));
  async function request(action, body) {
    const response = await WS.api("/api/b2c?action=" + action, body ? {
      method: "POST", body: JSON.stringify({ ...body, confirmed: true })
    } : undefined);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "B2C action failed.");
    return data;
  }
  async function mount(el, owner = true) {
    const [{ policy, readiness }, { dispatches }] = await Promise.all([
      request(owner ? "readiness" : "controls"), request("status")
    ]);
    el.innerHTML = `<h2>M-Pesa automated payouts</h2>
      <p><strong>Default OFF.</strong> Uses the same custody, reservations and execution claim as manual payouts.
      KYC completeness is not identity verification. Phone OTP proves control, not registered name.
      Independently checked identity/name evidence and current disbursable collected funds are required.</p>
      <p>Policy: <strong>${policy.enabled ? "enabled" : "OFF"}</strong>.
      Approval: <strong>${policy.require_four_eyes ? "two-person review" : "Owner-configured automated approval"}</strong>.
      Deployment: <strong>${readiness.ready ? "configured (not a provider health check)" : "held"}</strong>.
      Revision: ${esc(policy.revision)}.</p>
      <p>Missing deployment checks: ${esc(Object.entries(readiness.checks).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none")}.
      Auto-approval gate: ${readiness.autoApprovalGate ? "on" : "OFF"}.</p>
      <p><a href="docs/B2C-PAYOUTS.md">Contract evidence and operator guide</a> ·
      <a href="b2c-recipient.html">Couple destination-control and payout request</a>.
      No readiness provider probe is made.</p>
      <form id="b2c-policy"><h3>Owner-only audited policy</h3>
        <p>No financial thresholds, recipients or custody are preselected. Use explicit UUID allowlists and minor KES units.
        Disabling admission never releases an existing claim. Saving policy cannot enable deployment flags.</p>
        <label>Approval mode<select name="mode"><option value="human">Two-person review</option>
          <option value="automatic">Automated approval within explicit policy</option></select></label>
        <label>Policy fields JSON<textarea name="fields" rows="8" required
          placeholder="No default limits or eligible recipients"></textarea></label>
        <p>Fields: enabled, custody_ids, recipient_ids, per_payout_minor, daily_minor, payout_fee_minor,
        statement_max_age_minutes, shortcode, command_id, contract_reference, funding_reference.
        References are independently checked policy-evidence UUIDs; never secrets.</p>
        <label>Audit reason<input name="reason" minlength="10" maxlength="240" required></label>
        <button type="submit">Save revision-checked policy</button>
        <button type="button" id="b2c-stop">Stop new automated dispatch</button>
      </form>
      <form id="b2c-intake"><h3>Shared evidence and collected-funds onboarding (no transfer)</h3>
        <p>Only opaque secure-evidence UUIDs and SHA-256 digests. Never paste names, ID documents,
        statements, OTP codes or credentials. A different leader checks each evidence record.</p>
        <label>Operation<select name="kind"><option>evidence</option><option>check</option>
          <option>recipient</option><option>account</option><option>custody</option><option>statement</option>
          <option>settlement</option><option>source</option><option>debit</option><option>funding</option></select></label>
        <label>Structured metadata JSON<textarea name="data" rows="5" required></textarea></label>
        <p>See operator guide for each exact shape. Account/funds/batch/allocation operations are Owner-only.
        A Paybill collection receipt is not evidence that the balance is currently disbursable.</p>
        <button type="submit">Record evidence metadata</button>
      </form>
      <form id="b2c-approve"><h3>Human approval</h3>
        <label>Payout request UUID<input name="payoutId" required></label>
        <button type="submit">Approve as a different reviewer</button></form>
      <form id="b2c-dispatch"><h3>Dispatch</h3>
        <label>Payout request UUID<input name="payoutId" required></label>
        <label><input type="checkbox" required> Not a resend of a claimed or uncertain transfer.</label>
        <button type="submit"${policy.enabled && readiness.ready ? "" : " disabled"}>Dispatch once</button></form>
      <h3>Request and execution journal</h3><p>Unclaimed requests have no dispatch UUID yet.
      Acceptance is not payment. Callbacks retain reservations until independent
      official-statement reconciliation. Timeouts and errors never authorize retry.</p>
      <div class="table-wrap"><table><thead><tr><th>Payout</th><th>Dispatch</th><th>State</th></tr></thead><tbody>
      ${dispatches.map(d => `<tr><td>${esc(d.payout_id)}</td><td>${esc(d.id)}</td><td>${esc(d.state)}</td></tr>`).join("")}
      </tbody></table></div>
      <form id="b2c-reconcile"><h3>Independent final statement reconciliation</h3>
        <label>Dispatch UUID<input name="dispatchId" required></label>
        <label>Independently checked receipt-evidence UUID<input name="receiptEvidenceId" required></label>
        <label>Separate independently checked reconciliation-evidence UUID<input name="evidenceId" required></label>
        <label>Provider<input name="provider" value="daraja" readonly></label>
        <label>Canonical account UUID<input name="accountId" required></label>
        <label>Official statement UUID<input name="statementId" required></label>
        <label>Canonical debit line UUID<input name="lineId" required></label>
        <label>Currency<input name="currency" value="KES" readonly></label>
        <label>Official transaction reference<input name="transactionId" required></label>
        <label>Exact destination MSISDN<input name="msisdn" pattern="254[17][0-9]{8}" required></label>
        <label>Exact principal (minor KES)<input name="amountMinor" type="number" min="100" step="100" required></label>
        <label>Exact fee (minor KES)<input name="feeMinor" type="number" min="0" step="1" required></label>
        <label>Official transfer timestamp (ISO 8601 with timezone)<input name="transferredAt" required></label>
        <label>Official debit booking timestamp (ISO 8601 with timezone)<input name="bookedAt" required></label>
        <button type="submit">Reconcile exact receipt and separate statement debit</button></form>
      <form id="b2c-resolve"><h3>Conclusive no-transfer resolution</h3>
        <p>Uncertain is not failed. Official evidence must prove both no transfer and zero charge.
        Unknown/nonzero charges or conflicting success observations remain held. A different leader must confirm.</p>
        <label>Dispatch UUID<input name="dispatchId" required></label>
        <label>Independently checked no-transfer/zero-charge evidence UUID<input name="evidenceId" required></label>
        <label>Decision<select name="decision"><option value="propose">Propose (hold retained)</option>
          <option value="confirm">Independently confirm final no-transfer</option></select></label>
        <label><input type="checkbox" required> Evidence explicitly proves no transfer AND zero fee; this does not authorize resending the claim.</label>
        <button type="submit">Record evidence-backed resolution</button></form>
      <p id="b2c-notice" class="notice" role="status" aria-live="polite"></p>`;
    el.querySelector("#b2c-policy").hidden = !owner;
    if (owner) {
      el.querySelector('[name="mode"]').value = policy.require_four_eyes ? "human" : "automatic";
      const { revision, require_four_eyes, singleton, updated_at, updated_by, ...fields } = policy;
      el.querySelector('[name="fields"]').value = JSON.stringify(fields, null, 2);
    }
    const notice = message => { el.querySelector("#b2c-notice").textContent = message; };
    const submit = (selector, action, fields) => {
      el.querySelector(selector).addEventListener("submit", async event => {
        event.preventDefault();
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const result = await request(action, fields(Object.fromEntries(new FormData(event.target))));
          await mount(el, owner);
          notice(result.accepted ? "Accepted, not settled. Funds remain reserved."
            : result.reconciliationRequired ? "Uncertain: funds held. Do not retry."
              : result.id ? `Recorded: ${result.id}` : "Saved and audited.");
        } catch (error) { notice(error.message); button.disabled = false; }
      });
    };
    submit("#b2c-policy", "policy-save", v => ({ revision: policy.revision,
      changes: { ...JSON.parse(v.fields), require_four_eyes: v.mode === "human" }, reason: v.reason }));
    submit("#b2c-intake", "intake", v => ({ kind: v.kind, data: JSON.parse(v.data) }));
    submit("#b2c-approve", "approve", v => v);
    submit("#b2c-dispatch", "dispatch", v => ({ ...v, idempotencyKey: crypto.randomUUID() }));
    submit("#b2c-reconcile", "reconcile", v => ({ ...v, amountMinor: Number(v.amountMinor), feeMinor: Number(v.feeMinor) }));
    submit("#b2c-resolve", "resolve", v => ({ ...v, confirmResolution: v.decision === "confirm", actualFeeMinor: 0 }));
    el.querySelector("#b2c-stop").addEventListener("click", async () => {
      try {
        await request("policy-save", { revision: policy.revision, changes: { enabled: false },
          reason: "Owner emergency stop of new automated B2C dispatch" });
        await mount(el, owner);
        notice("New dispatch stopped. Existing claims and reconciliation remain active.");
      } catch (error) { notice(error.message); }
    });
  }
  window.B2CBackoffice = { mount };
})();
