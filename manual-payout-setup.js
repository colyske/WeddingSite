// Presentation only. Existing API/RPCs remain authoritative for every write.
export function kesToMinor(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error("Enter a KES amount with no commas and at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is too large to record exactly.");
  return Number(minor);
}

export function minorToKes(value) {
  if (!/^\d+$/.test(String(value))) throw new Error("Invalid stored minor-unit amount.");
  const minor = BigInt(value);
  return `${minor / 100n}.${String(minor % 100n).padStart(2, "0")}`;
}

export async function fileFingerprint(file) {
  if (!file || file.size === 0 || file.size > 20 * 1024 * 1024) throw new Error("Choose a nonempty evidence file no larger than 20 MiB.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

const uuid = () => {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("Secure reference generation is unavailable. Use an HTTPS browser.");
  return id;
};
const short = id => String(id).slice(0, 8);
const when = date => date ? new Date(date).toLocaleString() : "date not recorded";
const evidenceKinds = { account: "account", custody: "custody", recipient: "recipient", statement: "statement",
  "shared-account": "custody", "attribute-settlement": "settlement", "verify-transfer": "reconciliation",
  settlement: "settlement", source: "commitment", debit: "statement", receipt: "receipt", reconcile: "reconciliation" };
const moneyFields = new Set(["available", "settled", "amount", "actual", "fee", "held", "opening", "credit", "debit", "closing",
  "per_payout_minor", "daily_minor", "payout_fee_minor"]);
const names = { account: "Registered merchant account", custody: "WeddingSite account scope", custody_id: "Account scope for this policy",
  recipient: "Verified recipient revision", recipient_ids: "Recipients allowed by this policy", wedding: "Wedding",
  evidence: "Supporting evidence record", id: "Record to review", previous: "Previous statement", batch: "Statement containing this line",
  registry: "Canonical account-register reference", reference: "Secure evidence-register reference", sha256: "File fingerprint (SHA-256)",
  per_payout_minor: "Maximum per transfer, including fee", daily_minor: "Maximum total UTC-day exposure", payout_fee_minor: "Fee per payout",
  available: "Legacy opening available balance (excluding held funds)", held: "Legacy statement held funds", settled: "Actually settled contribution net",
  actual: "Actual transfer principal", amount: "Payout principal", fee: "Actual / agreed fee", fee_payer: "Who pays the fee",
  review_evidence: "Operating-policy review evidence", fee_evidence: "Fee agreement evidence",
  rail_evidence: "Funded rail entitlement evidence", secure_evidence: "Secure evidence-custody procedure evidence" };

export function mountSetup(panel, { workspace, weddings, role, esc }) {
  if (!workspace) return;
  const evidence = workspace.evidence || [], accounts = workspace.accounts || [], custody = workspace.custody || [];
  const recipients = workspace.recipients || [];
  const weddingLabel = id => {
    const w = weddings.find(w => w.id === id);
    return `Wedding ${short(id)}${w?.wedding_date ? ` · ${w.wedding_date}` : ""}${w?.currency ? ` · ${w.currency}` : ""}`;
  };
  const checked = e => (e.checks || []).some(c => c.checked_by !== e.submitted_by);
  const evidenceLabel = e => `${e.kind.replaceAll("_", " ")} · ${when(e.submitted_at)} · ${checked(e) ? "independent check recorded" :
    e.checks?.length ? "Owner-solo check only" : "awaiting check"} · ${short(e.id)}`;
  const accountLabel = a => `${a.provider} funding account · ${short(a.id)}`;
  const isShared = c => (workspace.sharedScopes || []).includes(c.id);
  const custodyLabel = c => `${c.provider} · ${c.currency} · account ${short(c.account_reference)} · ${isShared(c) ? "shared, WeddingSite attribution only" : `legacy statement ${when(c.latest_batch?.statement_at)}`}`;
  const recipientLabel = r => `${weddingLabel(r.wedding_id)} · ${r.provider} · recipient revision ${r.revision} · ${short(r.id)}`;
  const guide = document.createElement("section");
  guide.id = "manual-setup-guide";
  guide.innerHTML = `<h4>Start here: prepare manual payouts</h4>
    <p>You do not need to invent or copy database IDs. Create records below, then select them by their descriptions.
    Short reference suffixes only distinguish similar records; they are not bank or phone numbers.</p>
    <ol>
      <li><strong>Keep the real documents safe first.</strong> Choose your existing access-controlled evidence store and one canonical account register.
      Keep actual recipient/bank details and KYC documents there, not in these forms. No secure document store is provided here.</li>
      <li><strong>Add evidence and have it checked.</strong> The local file tool below computes a fingerprint without uploading the file.
      Save its opaque reference and fingerprint next to the original document in your secure register.
      Recording evidence is not verification. Another eligible leader must check it, unless the protected Owner explicitly selects audited solo mode.</li>
      <li><strong>Register the real shared merchant account and recipient.</strong> Choose checked evidence in
      <em>account</em>, then <em>shared-account</em> (account attribution, not a bank balance), and <em>recipient</em>.
      The account is already authorized, not a new merchant rail. Recipient revision binds actual recipient verification, private KYC and consent.</li>
      <li><strong>Prove wedding funds.</strong> Record actual contribution settlement and any prior payouts, expenses, refunds or holds.
      Use <em>attribute-settlement</em> for a real contribution's transaction-specific settlement proof. No Paybill balance,
      opening/closing statement, or transactions from other systems are required or counted. Existing WeddingSite obligations are deducted automatically.</li>
      <li><strong>Save reviewed policy OFF.</strong> Select prepared records, enter reviewed amounts and fees, and save the draft.
      Preparation does not activate admission. Enabling needs separate authorization and zero readiness blockers.
      Even an enabled gate does not transfer money: claim first, then an authorized operator checks liquidity and transfers in the official portal.
      An internal exposure reservation is not a bank reservation or availability guarantee. Verify the exact debit independently before marking paid.</li>
    </ol>
    <p>KES fields below use shillings and cents (KES 12.34 = 1234 minor units). No FX conversion is performed.
    Non-KES workflows keep explicitly labelled integer minor units.</p>
    <p role="status">Prepared records: ${accounts.length} merchant accounts; ${custody.length} accounting scopes;
    ${recipients.length} recipient revisions; ${evidence.length} evidence records. Database checks are re-run when you submit.</p>
    <p>${[["evidence", "1. Add real evidence"], ["check", "2. Check evidence"], ["account", "3. Register merchant account"],
      ["shared-account", "4. Prepare shared account attribution"], ["recipient", "5. Prepare verified recipient"],
      ["attribute-settlement", "6. Record actual contribution settlement"]].map(([action, label]) =>
      `<button type="button" data-setup-open="${action}">${label}</button>`).join(" ")}</p>`;
  panel.querySelector("#manual-policy")?.before(guide);
  if (!guide.isConnected) panel.querySelector("#manual-workspace")?.before(guide);
  guide.onclick = event => {
    const action = event.target.closest("[data-setup-open]")?.dataset.setupOpen;
    if (!action) return;
    const details = panel.querySelector(`[data-manual-panel="${action}"]`);
    details.open = true;
    details.scrollIntoView({ block: "start" });
    details.querySelector("input:not([type=hidden]),select")?.focus();
  };

  function picker(input, rows, label, multiple = false) {
    const select = document.createElement("select");
    select.name = input.name;
    select.required = input.required;
    select.multiple = multiple;
    select.dataset.contactAllowed = "";
    select.dataset.setupPicker = "";
    const current = multiple ? input.value.split(",").filter(Boolean) : [input.value];
    if (!multiple) select.add(new Option(`Choose ${label.toLowerCase()}`, ""));
    for (const [value, text] of rows) select.add(new Option(text, value, false, current.includes(value)));
    for (const id of current.filter(id => id && !rows.some(([value]) => value === id))) {
      const option = new Option(`Previously selected record unavailable in this list (${short(id)}); refresh or use retained audit references`, id, false, true);
      option.disabled = true;
      select.add(option);
    }
    input.replaceWith(select);
    return select;
  }
  function rowsFor(form, name) {
    const action = form.dataset.manualAction;
    const request = (workspace.requestDetails || []).find(r => r.id === form.elements.namedItem("id")?.value);
    const solo = form.elements.namedItem("owner_solo")?.checked === true || (role === "owner" && request?.owner_solo) ||
      (role === "owner" && ["account", "shared-account", "recipient", "attribute-settlement", "custody", "statement", "debit", "settlement", "source"].includes(action));
    const wedding = form.dataset.wedding || form.elements.namedItem("wedding")?.value;
    const balance = custody.find(c => c.id === (form.elements.namedItem("custody")?.value || form.elements.namedItem("custody_id")?.value));
    const evRows = kind => evidence.filter(e => !kind || e.kind === kind).filter(e =>
      action === "check" || checked(e) || ((solo || kind === "policy") && e.checks?.some(c => c.owner_solo)))
      .map(e => [e.id, evidenceLabel(e)]);
    if (name === "account" && action !== "account") return accounts.map(a => [a.id, accountLabel(a)]);
    if (["custody", "custody_id"].includes(name)) return custody.filter(c =>
      !["settlement", "source", "statement", "debit", "reconcile"].includes(action) || !isShared(c))
      .map(c => [c.id, custodyLabel(c)]);
    if (["recipient", "recipient_ids"].includes(name)) return recipients.filter(r =>
      (!wedding || r.wedding_id === wedding) && (!balance || r.provider === balance.provider && r.currency === balance.currency) &&
      !recipients.some(newer => newer.wedding_id === r.wedding_id && newer.provider === r.provider &&
        newer.currency === r.currency && Number(newer.revision) > Number(r.revision)))
      .map(r => [r.id, recipientLabel(r)]);
    if (name === "wedding") return weddings.map(w => [w.id, weddingLabel(w.id)]);
    if (name === "evidence") return evRows(evidenceKinds[action] || (action === "transition" ? "no_transfer" : null));
    if (name === "debit_evidence") return evRows("statement");
    if (name.endsWith("_evidence")) return evRows("policy");
    if (name === "id" && action === "check") return evRows(null);
    if (name === "id" && action === "review-intent") return (workspace.intents || []).map(i =>
      [i.id, `${weddingLabel(i.wedding_id)} · review ${i.status} · ${short(i.id)}`]);
    if (name === "id" && ["transition", "receipt", "reconcile", "verify-transfer"].includes(action)) return (workspace.requests || [])
      .filter(r => !r.automatic && r.claim?.channel !== "automatic_b2c")
      .map(r => [r.id, `Manual payout · ${short(r.id)}${r.claim ? ` · claimed ${when(r.claim.claimed_at)}` : " · unclaimed"}`]);
    if (name === "contribution" && action === "attribute-settlement") return (workspace.settlementCandidates || [])
      .filter(c => !balance || c.provider === balance.provider && c.currency === balance.currency)
      .map(c => [c.id, `${weddingLabel(c.wedding_id)} · ${c.provider} · ${c.currency} ${c.currency === "KES" ? minorToKes(c.net_minor) : `${c.net_minor} minor units`} · paid ${when(c.paid_at)} · ${short(c.id)}`]);
    if (["previous", "batch"].includes(name)) return custody.filter(c => !balance || c.id === balance.id)
      .filter(c => c.latest_batch).map(c => [c.latest_batch.id, `${custodyLabel(c)} · latest statement`]);
    return null;
  }
  function refresh(form) {
    for (const select of form.querySelectorAll("select[data-setup-picker]")) {
      const rows = rowsFor(form, select.name);
      if (rows) picker(select, rows, names[select.name] || select.name, select.multiple);
    }
    const c = custody.find(c => c.id === (form.elements.namedItem("custody")?.value || form.elements.namedItem("custody_id")?.value));
    const a = accounts.find(a => a.id === form.elements.namedItem("account")?.value);
    const w = weddings.find(w => w.id === form.elements.namedItem("wedding")?.value);
    const currency = c?.currency || w?.currency || form.elements.namedItem("currency")?.value;
    if (c || a) {
      if (form.elements.namedItem("provider")) form.elements.namedItem("provider").value = (c || a).provider;
      if (c && form.elements.namedItem("currency")) form.elements.namedItem("currency").value = c.currency;
    }
    for (const input of form.querySelectorAll("[data-setup-money]")) {
      const kes = currency === "KES";
      if (input.dataset.setupMoney !== (kes ? "KES" : "minor")) {
        input.value = input.dataset.setupMoney === "initial" ? kes && input.value ? minorToKes(input.value) : input.value : "";
        input.dataset.setupMoney = kes ? "KES" : "minor";
      }
      const freshness = form.elements.namedItem("statement_max_age_minutes");
      if (freshness) {
        freshness.closest("label").hidden = c && isShared(c);
        if (c && isShared(c)) freshness.value = "";
      }
      input.closest("label").querySelector("[data-money-label]").textContent =
        `${names[input.name] || input.name} (${kes ? "KES, shillings.cents" : "integer minor units; select currency first"})`;
    }
  }
  for (const form of panel.querySelectorAll("[data-manual-action], [data-manual-policy='draft']")) {
    for (const input of [...form.querySelectorAll("input:not([type=hidden]):not([type=checkbox])")]) {
      const rows = rowsFor(form, input.name);
      if (rows) {
        const label = input.closest("label");
        label.firstChild.textContent = names[input.name] || input.name;
        picker(input, rows, names[input.name] || input.name, input.name === "recipient_ids");
      } else if (moneyFields.has(input.name)) {
        input.type = "text";
        input.inputMode = "decimal";
        input.dataset.setupMoney = "initial";
        const label = input.closest("label");
        label.firstChild.textContent = "";
        const span = document.createElement("span");
        span.dataset.moneyLabel = "";
        label.prepend(span);
      }
    }
    if (form.dataset.manualAction === "account") {
      form.elements.namedItem("account").type = "hidden";
      form.elements.namedItem("account").value = uuid();
      form.elements.namedItem("account").closest("label").hidden = true;
      const registry = form.elements.namedItem("registry");
      registry.closest("label").firstChild.textContent = "Reference from your canonical account register (not a bank account number)";
      const help = document.createElement("p");
      help.innerHTML = `Use the existing register entry for this real account; never assign another reference to an alias of the same account.
        For a genuinely new real account only: <button type="button" data-new-registry>Assign a new register reference</button>
        Save that reference in your secure register and confirm the account is not already registered. This does not open or fund an account.`;
      registry.closest("label").after(help);
      help.querySelector("button").onclick = () => {
        if (confirm("Have you checked the canonical account register and confirmed this real account has no existing entry? Save this new reference there before submitting.")) registry.value = uuid();
      };
    }
    if (form.dataset.manualAction === "evidence") evidenceTool(form);
    if (form.elements.namedItem("key")) form.elements.namedItem("key").closest("label").hidden = true;
    if (form.dataset.manualAction === "attribute-settlement") {
      const line = form.elements.namedItem("line");
      line.value = uuid();
      line.type = "hidden";
      line.closest("label").hidden = true;
      form.addEventListener("manual-prefilled", () => { if (!line.value) line.value = uuid(); });
      form.addEventListener("change", event => {
        if (event.target.name !== "contribution") return;
        const c = (workspace.settlementCandidates || []).find(c => c.id === event.target.value);
        if (c) prefillSetupValue(form.elements.namedItem("settled"), c.net_minor);
      });
    }
    const payer = form.elements.namedItem("fee_payer");
    if (payer) picker(payer, [["wedding", "Wedding pays the explicitly agreed fee"]], "fee payer");
    form.addEventListener("change", () => refresh(form));
    form.addEventListener("manual-prefilled", () => refresh(form));
    refresh(form);
  }

  function evidenceTool(form) {
    const reference = form.elements.namedItem("reference"), hash = form.elements.namedItem("sha256");
    let fingerprintRevision = 0;
    reference.closest("label").firstChild.textContent = "Opaque reference in your secure evidence register (not a document URL)";
    hash.closest("label").firstChild.textContent = "SHA-256 fingerprint of the original file (not a password)";
    const tools = document.createElement("fieldset");
    tools.innerHTML = `<legend>Prepare an evidence reference without copying a hash</legend>
      <p>Keep the original in your approved secure store. This tool reads the file only in this browser; it does not upload it,
      store its name or contents, or prove that it is true. Do not select a file on a shared/untrusted device.</p>
      <label>Original evidence file (local fingerprint only, up to 20 MiB)<input type="file" data-evidence-file></label>
      <button type="button" data-new-evidence>Assign a new evidence-register reference</button>
      <button type="button" data-save-reference>Download reference card for the secure register</button>
      <p data-evidence-status role="status"></p>
      <label><input type="checkbox" required data-register-saved> I have saved this reference and fingerprint beside the original in our access-controlled register.
      This records my attestation only; the required check is a separate action.</label>`;
    reference.closest("label").before(tools);
    for (const input of [reference, hash, form.elements.namedItem("kind")]) {
      input.addEventListener("input", () => { tools.querySelector("[data-register-saved]").checked = false; });
    }
    tools.querySelector("[data-new-evidence]").onclick = () => {
      reference.value = uuid();
      tools.querySelector("[data-register-saved]").checked = false;
      tools.querySelector("[data-evidence-status]").textContent = `Save reference ${reference.value} beside the original before recording evidence.`;
    };
    tools.querySelector("[data-evidence-file]").onchange = async event => {
      const revision = ++fingerprintRevision;
      hash.value = "";
      tools.querySelector("[data-register-saved]").checked = false;
      tools.querySelector("[data-register-saved]").disabled = true;
      try {
        const fingerprint = await fileFingerprint(event.target.files[0]);
        if (revision !== fingerprintRevision) return;
        hash.value = fingerprint;
        tools.querySelector("[data-evidence-status]").textContent = `Computed locally. Fingerprint: ${hash.value}. Save it and the reference in your secure register. Nothing was uploaded or verified.`;
      } catch (error) {
        if (revision === fingerprintRevision) tools.querySelector("[data-evidence-status]").textContent = error.message;
      } finally {
        if (revision === fingerprintRevision) tools.querySelector("[data-register-saved]").disabled = false;
      }
    };
    tools.querySelector("[data-save-reference]").onclick = () => {
      if (!/^[0-9a-f-]{36}$/i.test(reference.value) || !/^[0-9a-f]{64}$/.test(hash.value)) {
        tools.querySelector("[data-evidence-status]").textContent = "Prepare the reference and real file fingerprint first.";
        return;
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify({ reference: reference.value, sha256: hash.value,
        kind: form.elements.namedItem("kind").value }, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "evidence-reference.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  }
}

export function readSetupValue(form, field) {
  const input = form.elements.namedItem(field);
  if (input?.multiple) return [...input.selectedOptions].filter(o => !o.disabled).map(o => o.value);
  if (input?.selectedOptions?.[0]?.disabled) throw new Error("A selected record is unavailable. Refresh and choose a current prepared record.");
  const value = input?.value.trim() || "";
  if (input?.dataset.setupMoney === "KES") return value === "" ? null : kesToMinor(value);
  if (input?.dataset.setupMoney === "minor" && value !== "" && !/^\d+$/.test(value)) throw new Error("Enter integer minor units for this currency.");
  return value;
}

export function prefillSetupValue(input, value) {
  input.value = input.dataset.setupMoney === "KES" && value !== "" && value !== null ? minorToKes(value) : String(value ?? "");
}
