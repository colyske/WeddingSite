import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

test("B2C dashboard defaults to four-eyes, no limits and disabled dispatch; leadership cannot edit Owner policy", async () => {
  let browser;
  try {
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage();
    await page.setContent('<main id="panel"></main>');
    await page.evaluate(() => {
      window.syntheticCalls = [];
      window.WS = {
        esc: s => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
        money: amount => String(amount),
        api: async (url, options) => {
          window.syntheticCalls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
          const action = new URL(url, "https://synthetic.test").searchParams.get("action");
          const data = action === "status" ? { dispatches: [] } : {
            policy: { revision: 1, enabled: false, require_four_eyes: true, per_payout_minor: null, daily_minor: null,
              custody_ids: [], recipient_ids: [] },
            readiness: { ready: false, checks: { killSwitch: false, contract: false }, autoApprovalGate: false }
          };
          return { ok: true, json: async () => data };
        }
      };
    });

    await page.addScriptTag({ path: "b2c-backoffice.js" });
    await page.evaluate(() => window.B2CBackoffice.mount(document.getElementById("panel"), true));
    assert.equal(await page.locator('#b2c-policy [name="mode"]').inputValue(), "human");
    const fields = JSON.parse(await page.locator('#b2c-policy [name="fields"]').inputValue());
    assert.equal(fields.per_payout_minor, null);
    assert.equal(fields.daily_minor, null);
    assert.deepEqual(fields.recipient_ids, []);
    assert.equal(await page.locator('#b2c-dispatch button[type="submit"]').isDisabled(), true);
    assert.ok((await page.locator("#panel").innerText()).includes("KYC completeness is not identity verification"));
    assert.equal((await page.evaluate(() => window.syntheticCalls)).some(call => call.body), false);
    await page.evaluate(() => window.B2CBackoffice.mount(document.getElementById("panel"), false));
    assert.equal(await page.locator("#b2c-policy").isVisible(), false);
    assert.equal(await page.locator("#b2c-intake").isVisible(), true);
    assert.equal(await page.locator("#b2c-reconcile").isVisible(), true);
    assert.ok((await page.evaluate(() => window.syntheticCalls)).some(call => call.url.endsWith("action=controls")));
  } finally {
    await browser?.close();
  }
});

test("couple request keys survive lost responses; a distinct request requires confirmed terminal state", async () => {
  let browser;
  try {
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ status: 200, body: "" }));
    await page.goto("https://synthetic.test/");
    const html = await readFile(new URL("../b2c-recipient.html", import.meta.url), "utf8");
    await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""));
    await page.evaluate(() => {
      window.syntheticRequests = [];
      window.syntheticState = "uncertain";
      window.WS = { token: () => "synthetic", api: async (url, options) => {
        if (!options) return { ok: true, json: async () => ({ requests: [{ id: "payout", state: window.syntheticState }] }) };
        const body = JSON.parse(options.body);
        window.syntheticRequests.push(body);
        if (window.syntheticRequests.length === 1) throw new Error("Synthetic lost response");
        return { ok: true, json: async () => ({ id: "payout" }) };
      } };
    });
    await page.addScriptTag({ path: "b2c-recipient.js" });
    await page.locator("#wedding").fill("10000000-0000-4000-8000-000000000001");
    await page.locator('#request [name="recipientId"]').fill("10000000-0000-4000-8000-000000000002");
    await page.locator('#request [name="custodyId"]').fill("10000000-0000-4000-8000-000000000003");
    await page.locator('#request [name="amountMinor"]').fill("10000");
    const submit = page.locator('#request button[type="submit"]');
    await submit.click();
    await page.waitForFunction(() => document.getElementById("notice").textContent.includes("lost response"));
    await submit.click();
    await page.waitForFunction(() => document.getElementById("notice").textContent.includes("Payout requested"));
    await page.locator("#new-request").click();
    await page.waitForFunction(() => document.getElementById("notice").textContent.includes("not confirmed closed"));
    await submit.click();
    await page.waitForFunction(() => window.syntheticRequests.length === 3);
    let keys = await page.evaluate(() => window.syntheticRequests.map(r => r.key));
    assert.equal(new Set(keys).size, 1);
    await page.evaluate(() => { window.syntheticState = "paid"; });
    await page.locator("#new-request").click();
    await page.waitForFunction(() => document.getElementById("notice").textContent.includes("distinct request key"));
    await submit.click();
    await page.waitForFunction(() => window.syntheticRequests.length === 4);
    keys = await page.evaluate(() => window.syntheticRequests.map(r => r.key));
    assert.notEqual(keys[3], keys[0]);
  } finally { await browser?.close(); }
});
