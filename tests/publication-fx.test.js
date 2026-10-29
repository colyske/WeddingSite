import test from "node:test";
import assert from "node:assert/strict";
import { validatedFx, publicationMethodQuote, ensurePublicationFx, MAX_FX_AGE_MS } from "../server/publication-fx.js";
import "../currencies.js";
import { paymentAdaptersFor } from "../api/checkout.js";

test("publication FX uses the approved USD feed, rejects stale/future/invalid rates and rounds up by payment unit", () => {
  const now = Date.parse("2026-10-29T18:00:00Z");
  const payload = { result: "success", base_code: "USD", time_last_update_utc: new Date(now).toUTCString(),
    rates: { USD: 1, KES: 129.832372, EUR: 0.897215, BAD: -1 } };
  assert.equal(validatedFx(payload, now).rates.KES, 129.832372);
  assert.equal(validatedFx(payload, now).rates.BAD, undefined);
  for (const published of [now - MAX_FX_AGE_MS - 1000, now + 3600000]) {
    assert.throws(() => validatedFx({ ...payload, time_last_update_utc: new Date(published).toUTCString() }, now), /older than 36 hours/);
  }
  assert.throws(() => validatedFx({ ...payload, base_code: "KES" }, now));
  assert.throws(() => validatedFx({ ...payload, rates: { USD: 2 } }, now));
  const quote = { fee_minor: 324581, currency: "KES", usd_amount_minor: 2500 };
  assert.equal(publicationMethodQuote(quote, "paystack").fee_minor, 324581);
  assert.equal(publicationMethodQuote(quote, "daraja").fee_minor, 324600);
  assert.equal(publicationMethodQuote({ ...quote, fee_minor: 100 }, "daraja").fee_minor, 100);
  assert.equal(publicationMethodQuote(quote, "daraja").usd_amount_minor, 2500);
});

test("FX snapshot service fails closed when stale, preserves fresh timestamped cache and never trusts browser rates", async () => {
  const env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "fixture-service" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const original = globalThis.fetch;
  let age = 37, failed = true, inserts = 0, external = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "open.er-api.com") {
      external++;
      if (failed) return Response.json({}, { status: 503 });
      return Response.json({ result: "success", base_code: "USD", time_last_update_utc: new Date().toUTCString(), rates: { USD: 1, KES: 129.832372 } });
    }
    assert.equal(url.pathname, "/rest/v1/publication_fx_snapshots");
    if (init.method === "POST") {
      inserts++;
      assert.equal(JSON.parse(init.body).rates.KES, 129.832372);
      return new Response(null, { status: 201 });
    }
    return Response.json([{ published_at: new Date(Date.now() - age * 3600000).toISOString(), rates: { USD: 1, KES: 129 } }]);
  };
  try {
    await ensurePublicationFx("USD");
    assert.equal(external, 0);
    await assert.rejects(() => ensurePublicationFx("KES"), /fresh publication-fee exchange rate/);
    age = 25;
    await ensurePublicationFx("KES");
    assert.equal(inserts, 0, "fresh retained rate must not be rewritten after a failed refresh");
    failed = false;
    await ensurePublicationFx("KES");
    assert.equal(inserts, 1);
    age = 2;
    await ensurePublicationFx("KES");
    assert.equal(inserts, 1);
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("broad currency display is distinct from safe two-decimal accounting and configured merchant acceptance", () => {
  const currencies = globalThis.WSCurrencies;
  assert.ok(currencies.displayCodes.length > 150);
  assert.ok(currencies.accountingCodes.length > 100);
  assert.equal(currencies.exponent("JPY"), 0);
  assert.equal(currencies.exponent("KWD"), 3);
  assert.ok(currencies.supportsAccounting("KES"));
  assert.ok(currencies.supportsAccounting("BRL"));
  assert.ok(!currencies.supportsAccounting("JPY"));
  assert.ok(!currencies.supportsAccounting("KWD"));
  assert.ok(!currencies.supportsAccounting("ZZZ"));
  const env = { WEDDINGSITE_PAYMENT_MODE: "test", PAYSTACK_SECRET_KEY: "sk_test_currency",
    PAYSTACK_SUPPORTED_CURRENCIES: "KES,JPY,KWD", PAYSTACK_SUPPORTED_MARKETS: "KE" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    assert.ok(paymentAdaptersFor("KES", "KE").some(item => item.id === "paystack"));
    assert.deepEqual(paymentAdaptersFor("JPY", "KE"), []);
    assert.deepEqual(paymentAdaptersFor("KWD", "KE"), []);
    assert.deepEqual(paymentAdaptersFor("BRL", "KE"), [], "display/accounting support cannot invent merchant acceptance");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
