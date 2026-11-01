import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("sponsor CTA without packages opens a paid-only custom sponsorship with the server minimum and an M-Pesa styled submit", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.includes("..")) throw new Error("Invalid path");
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" })
        .end(await readFile(new URL(`..${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
    await page.route("https://**", route => route.fulfill({ body: "" }));
    const wedding = { id: "550e8400-e29b-41d4-a716-446655440000", slug: "qa-couple", couple_names: "QA Couple",
      wedding_date: "2099-01-01", currency: "KES", palette: ["#244b3a"] };
    await page.route("**/api/guest**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      const body = action === "site" ? { wedding } : action === "fundraising" ? { campaigns: [], tiers: [], sponsors: [] } : {};
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    const checkoutActions = [];
    await page.route("**/api/checkout**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      checkoutActions.push(action || route.request().method());
      if (action === "custom-sponsor") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        available: true, currency: "KES", minimumMinor: 500000, floorCurrency: "KES", floorAmountMinor: 500000 }) });
      if (action === "options") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        paymentAvailable: true, mode: "live", providers: [{ id: "daraja", name: "M-Pesa", market: "KE", label: "M-Pesa" }] }) });
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"message":"never initiate payment"}' });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/guest.html?slug=qa-couple`);
    await page.locator("#sponsor-cta").click();
    await page.locator("#pay-dialog[open]").waitFor();
    assert.equal(await page.locator("#pay-title").textContent(), "Custom paid sponsorship");
    assert.equal(await page.locator("#pay-amount").inputValue(), "5000");
    assert.equal(await page.locator("#pay-amount").getAttribute("min"), "5000");
    assert.equal(await page.locator("#pay-amount").getAttribute("readonly"), null, "sponsor chooses the amount");
    assert.equal(await page.locator("#pay-sponsor-fields").isHidden(), false);
    assert.match(await page.locator("#pay-summary").textContent(), /not a package or a featured-bid placement/);
    await page.waitForFunction(() => document.getElementById("pay-submit").classList.contains("pay-mpesa"));
    await page.waitForFunction(() => ["rgb(0, 112, 60)", "rgb(63, 125, 92)"].includes(getComputedStyle(document.getElementById("pay-submit")).backgroundColor));
    const style = await page.locator("#pay-submit").evaluate(el => ({ disabled: el.disabled, bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, h: el.getBoundingClientRect().height }));
    assert.equal(style.bg, style.disabled ? "rgb(63, 125, 92)" : "rgb(0, 112, 60)");
    assert.equal(style.color, "rgb(255, 255, 255)");
    assert.ok(style.h >= 44);

    await page.fill("#pay-amount", "4999");
    assert.equal(await page.locator("#pay-amount").evaluate(el => el.validity.rangeUnderflow), true, "browser blocks amounts below the floor");
    await page.locator("#pay-submit").click({ force: true }).catch(() => {});
    assert.deepEqual(checkoutActions.filter(a => !["custom-sponsor", "options"].includes(a)), [], "no payment initiated below the floor");
  } finally {
    await browser?.close();
    server.close();
  }
});
