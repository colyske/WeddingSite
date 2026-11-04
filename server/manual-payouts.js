// Only opaque evidence IDs/digests cross this boundary; never recipient details.
const uuid = v => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const amount = v => Number.isSafeInteger(v) && v > 0;
const fee = v => Number.isSafeInteger(v) && v >= 0;
const currency = v => typeof v === "string" && /^[A-Z]{3}$/.test(v);
const timestamp = v => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v));
const optionalUuid = v => v === null || uuid(v);
const ownerSolo = v => v === undefined || typeof v === "boolean";
const policyFields = {
  enabled: v => typeof v === "boolean", custody_id: optionalUuid,
  recipient_ids: v => Array.isArray(v) && v.length <= 100 && v.every(uuid) && new Set(v).size === v.length,
  per_payout_minor: v => v === null || amount(v), daily_minor: v => v === null || amount(v),
  payout_fee_minor: v => v === null || fee(v),
  fee_payer: v => v === null || v === "wedding",
  statement_max_age_minutes: v => v === null || (Number.isSafeInteger(v) && v > 0 && v <= 2147483647),
  review_evidence: optionalUuid, fee_evidence: optionalUuid, rail_evidence: optionalUuid, secure_evidence: optionalUuid
};
const policyChanges = v => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 &&
  Object.entries(v).every(([key, value]) => Object.hasOwn(policyFields, key) && policyFields[key](value));
const specs = {
  "simple-action": ["simple_payout_action", {
    id: uuid, key: uuid, action: v => ["hold", "reviewed", "processing", "paid", "cancelled"].includes(v),
    reason: v => v === null || ["recipient_check", "funds_review", "operator_unavailable", "outcome_uncertain", "other_review"].includes(v),
    fee: v => v === null || fee(v), reference: v => v === null || typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v),
    solo: v => typeof v === "boolean", recipient_confirmed: v => typeof v === "boolean"
  }],
  "shared-account": ["manual_payout_register_shared_account", { account: uuid, currency, evidence: uuid }],
  "attribute-settlement": ["manual_payout_attribute_settlement", {
    contribution: uuid, custody: uuid, line: uuid, settled: amount, at: timestamp, evidence: uuid
  }],
  "verify-transfer": ["manual_payout_verify_transfer", {
    id: uuid, reference: v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v),
    actual: amount, fee, currency, at: timestamp, debit_evidence: uuid, evidence: uuid
  }],
  "review-intent": ["manual_payout_review_intent", {
    id: uuid, decision: v => v === "created" || v === "declined", key: optionalUuid, custody: optionalUuid,
    recipient: optionalUuid, fee: v => v === null || fee(v), owner_solo: v => typeof v === "boolean"
  }],
  policy: ["owner_set_manual_payout_policy", { revision: uuid, changes: policyChanges }],
  evidence: ["manual_payout_submit_evidence", {
    kind: v => ["account", "commitment", "statement", "recipient", "custody", "settlement", "receipt", "reconciliation", "no_transfer", "policy"].includes(v),
    reference: uuid, sha256: v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)
  }],
  check: ["manual_payout_check_evidence", { id: uuid, owner_solo: ownerSolo }],
  recipient: ["manual_payout_recipient", {
    wedding: uuid, evidence: uuid, provider: v => typeof v === "string" && /^[a-z][a-z0-9_-]{1,39}$/.test(v), currency
  }],
  custody: ["manual_payout_register_custody", {
    provider: v => typeof v === "string" && /^[a-z][a-z0-9_-]{1,39}$/.test(v),
    account: uuid, currency, available: fee, statement_at: timestamp, evidence: uuid, held: fee
  }],
  account: ["manual_payout_register_account", {
    account: uuid, provider: v => typeof v === "string" && /^[a-z][a-z0-9_-]{1,39}$/.test(v), registry: uuid, evidence: uuid
  }],
  statement: ["manual_payout_append_statement", {
    custody: uuid, previous: uuid, statement: uuid, at: timestamp,
    opening: fee, credit: fee, debit: fee, closing: fee, held: fee, evidence: uuid
  }],
  source: ["manual_payout_map_source", {
    kind: v => ["payout", "expense", "adjustment"].includes(v), source: uuid, custody: uuid,
    batch: optionalUuid, evidence: uuid, line: optionalUuid, at: v => v === null || timestamp(v)
  }],
  debit: ["manual_payout_register_statement_debit", {
    batch: uuid, line: uuid, reference: v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v),
    actual: amount, fee, currency, at: timestamp, evidence: uuid
  }],
  settlement: ["manual_payout_register_settlement", {
    contribution: uuid, custody: uuid, line: uuid, settled: amount, evidence: uuid, batch: optionalUuid, at: timestamp
  }],
  request: ["manual_payout_request", { key: uuid, wedding: uuid, custody: uuid, recipient: uuid, amount, fee, currency, owner_solo: ownerSolo }],
  transition: ["manual_payout_transition", {
    id: uuid, action: v => ["approved", "executing", "cancelled", "uncertain", "resolution_proposed", "not_transferred"].includes(v),
    key: optionalUuid, evidence: optionalUuid
  }],
  receipt: ["manual_payout_report", {
    id: uuid, reference: v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v),
    actual: amount, fee, currency, at: timestamp, evidence: uuid
  }],
  reconcile: ["manual_payout_reconcile", {
    id: uuid, provider: v => typeof v === "string" && /^[a-z][a-z0-9_-]{1,39}$/.test(v),
    account: uuid, statement: uuid, line: uuid,
    reference: v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v),
    actual: amount, fee, currency, at: timestamp, evidence: uuid
  }]
};

export function manualPayoutCommand(action, body, role) {
  if (!["owner", "superadmin"].includes(role)) return { status: 403, error: "Leadership access required." };
  if (action === "policy" && role !== "owner") return { status: 403, error: "Only the protected Owner may configure manual admission." };
  const spec = specs[action];
  if (!spec || !body || typeof body !== "object" || Array.isArray(body) || body.confirmed !== true ||
      Object.keys(body).some(k => k !== "confirmed" && !Object.hasOwn(spec[1], k)) ||
      Object.entries(spec[1]).some(([key, valid]) => !valid(body[key]))) {
    return { status: 400, error: "Confirm all manual-only fields. Use opaque evidence references, never personal or banking details." };
  }
  if (action === "evidence" && body.kind === "policy" && role !== "owner") {
    return { status: 403, error: "Only the protected Owner may record policy evidence; this cannot activate payouts." };
  }
  if (body.owner_solo === true && role !== "owner") {
    return { status: 403, error: "Only the protected Owner may explicitly select solo manual mode." };
  }
  if (action === "simple-action") {
    if (body.solo && role !== "owner") return { status: 403, error: "Only the protected Owner may choose solo processing." };
    if ((body.action === "hold" ? body.reason === null : body.reason !== null) ||
      (body.action === "processing" ? body.fee === null || !body.recipient_confirmed : body.fee !== null || body.solo) ||
      (body.action === "paid" ? body.reference === null : body.reference !== null) ||
      (!["reviewed", "processing"].includes(body.action) && body.recipient_confirmed)) {
      return { status: 400, error: "Confirm only the fields for this payout action." };
    }
  }
  if (action === "review-intent" && (body.decision === "created" ?
    !uuid(body.key) || !uuid(body.custody) || !uuid(body.recipient) || !fee(body.fee) :
    body.key !== null || body.custody !== null || body.recipient !== null || body.fee !== null || body.owner_solo)) {
    return { status: 400, error: "Create requires explicit payout settings; decline accepts none." };
  }
  const args = Object.fromEntries(Object.keys(spec[1]).filter(key => body[key] !== undefined).map(key => [`p_${key}`, body[key]]));
  if (["policy", "review-intent", "simple-action"].includes(action)) args.p_confirmed = true;
  return { rpc: spec[0], args };
}
