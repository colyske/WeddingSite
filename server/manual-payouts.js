// Only opaque evidence IDs/digests cross this boundary; never recipient details.
const uuid = v => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const amount = v => Number.isSafeInteger(v) && v > 0;
const fee = v => Number.isSafeInteger(v) && v >= 0;
const currency = v => typeof v === "string" && /^[A-Z]{3}$/.test(v);
const timestamp = v => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v));
const optionalUuid = v => v === null || uuid(v);
const specs = {
  evidence: ["manual_payout_submit_evidence", {
    kind: v => ["recipient", "custody", "settlement", "receipt", "no_transfer", "policy"].includes(v),
    reference: uuid, sha256: v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)
  }],
  check: ["manual_payout_check_evidence", { id: uuid }],
  recipient: ["manual_payout_recipient", {
    wedding: uuid, evidence: uuid, provider: v => typeof v === "string" && /^[a-z][a-z0-9_-]{1,39}$/.test(v), currency
  }],
  custody: ["manual_payout_register_custody", {
    provider: v => typeof v === "string" && /^[a-z][a-z0-9_-]{1,39}$/.test(v),
    account: uuid, currency, available: amount, statement_at: timestamp, evidence: uuid
  }],
  settlement: ["manual_payout_register_settlement", { contribution: uuid, custody: uuid, line: uuid, settled: amount, evidence: uuid }],
  request: ["manual_payout_request", { key: uuid, wedding: uuid, custody: uuid, recipient: uuid, amount, fee, currency }],
  transition: ["manual_payout_transition", {
    id: uuid, action: v => ["approved", "executing", "cancelled", "uncertain", "resolution_proposed", "not_transferred", "paid"].includes(v),
    key: optionalUuid, evidence: optionalUuid
  }],
  receipt: ["manual_payout_report", {
    id: uuid, reference: v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v),
    actual: amount, fee, currency, at: timestamp, evidence: uuid
  }]
};

export function manualPayoutCommand(action, body, role) {
  if (!["owner", "superadmin"].includes(role)) return { status: 403, error: "Leadership access required." };
  const spec = specs[action];
  if (!spec || !body || typeof body !== "object" || Array.isArray(body) || body.confirmed !== true ||
      Object.keys(body).some(k => k !== "confirmed" && !Object.hasOwn(spec[1], k)) ||
      Object.entries(spec[1]).some(([key, valid]) => !valid(body[key]))) {
    return { status: 400, error: "Confirm all manual-only fields. Use opaque evidence references, never personal or banking details." };
  }
  if (action === "evidence" && body.kind === "policy" && role !== "owner") {
    return { status: 403, error: "Only the protected Owner may record policy evidence; this cannot activate payouts." };
  }
  return { rpc: spec[0], args: Object.fromEntries(Object.keys(spec[1]).map(key => [`p_${key}`, body[key]])) };
}
