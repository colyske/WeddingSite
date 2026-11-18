import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("facilitator can consent to and save their own recipient revision in referrals UI", { timeout: 180000 }, async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.includes("..")) throw new Error("Invalid path");
      const body = await readFile(new URL(`..${path}`, import.meta.url));
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge", timeout: 15000 }); } catch { browser = await chromium.launch({ timeout: 15000 }); }
    const page = await browser.newPage();
    page.on("pageerror", error => console.error("Facilitator recipient browser error:", error.message));
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "fixture-token" })));
    let optedIn = true;
    await page.route("**/api/referrals**", async route => {
      const url = new URL(route.request().url());
      const action = url.searchParams.get("action");
      if (action === "summary") return route.fulfill({ json: {
        account: { opted_in: optedIn, code: "a".repeat(32), consent_at: "fixture", terms_version: "client-referrals-v1" },
        referral_count: 0, weddings: []
      } });
      if (action === "consent") {
        optedIn = route.request().postDataJSON().optedIn;
        return route.fulfill({ json: { opted_in: optedIn } });
      }
      if (action === "recipient-mine") return route.fulfill({ json: {
        recipient: {
          revision: "550e8400-e29b-41d4-a716-446655440000",
          full_name: "Facilitator Example", phone: "254712345678", status: "pending"
        }
      } });
      if (action === "recipient-submit") {
        const body = route.request().postDataJSON();
        assert.equal(body.consent, true);
        assert.equal(body.consentVersion, "facilitator-mpesa-recipient-v1");
        assert.equal(body.fullName, "Facilitator Example");
        assert.equal(body.phone, "0712 345 678");
        assert.ok(body.requestKey);
        return route.fulfill({ json: { revision: "550e8400-e29b-41d4-a716-446655440000", status: "pending" } });
      }
      return route.fulfill({ status: 404, json: { error: "Unexpected referral action." } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/referrals.html`);
    await page.locator("#recipient-section").waitFor({ state: "visible" });
    await page.locator("#recipient-name").fill("Facilitator Example");
    await page.locator("#recipient-phone").fill("0712 345 678");
    await page.locator("#recipient-consent").check();
    await page.locator("#recipient-form button").click();
    await page.getByText(/Recipient revision saved \(pending\)/).waitFor();
    assert.match(await page.locator("#recipient-status").textContent(), /reviewed external evidence|leadership must record/i);
    await page.locator("#recipient-consent").uncheck();
    assert.equal(await page.locator("#recipient-consent").isChecked(), false);
    await page.locator("#referral-withdraw").click();
    await page.getByText(/Opt-in withdrawn/).waitFor();
    assert.equal(await page.locator("#recipient-section").isVisible(), true);
    assert.equal(await page.locator("#recipient-name").inputValue(), "Facilitator Example");
    await page.locator("#recipient-phone").fill("0712 345 678");
    await page.locator("#recipient-consent").check();
    await page.locator("#recipient-form button").click();
    await page.getByText(/Recipient revision saved \(pending\)/).waitFor();
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
