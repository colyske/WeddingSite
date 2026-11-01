import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

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
            policy: { revision: 1, dispatch_enabled: false, require_four_eyes: true, auto_approval_limits: null },
            readiness: { ready: false, checks: { killSwitch: false, contract: false }, autoApprovalGate: false }
          };
          return { ok: true, json: async () => data };
        }
      };
    });
    await page.addScriptTag({ path: "b2c-backoffice.js" });
    await page.evaluate(() => window.B2CBackoffice.mount(document.getElementById("panel"), true));
    assert.equal(await page.locator('#b2c-policy [name="mode"]').inputValue(), "human");
    assert.equal(await page.locator('#b2c-policy [name="limits"]').inputValue(), "");
    assert.equal(await page.locator('#b2c-dispatch button[type="submit"]').isDisabled(), true);
    assert.ok((await page.locator("#panel").innerText()).includes("KYC completeness is not identity verification"));
    assert.equal((await page.evaluate(() => window.syntheticCalls)).some(call => call.body), false);
    await page.evaluate(() => window.B2CBackoffice.mount(document.getElementById("panel"), false));
    assert.equal(await page.locator("#b2c-policy").isVisible(), false);
    assert.equal(await page.locator("#b2c-recipient").isVisible(), false);
    assert.equal(await page.locator("#b2c-reconcile").isVisible(), true);
    assert.ok((await page.evaluate(() => window.syntheticCalls)).some(call => call.url.endsWith("action=controls")));
  } finally {
    await browser?.close();
  }
});
