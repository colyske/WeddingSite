import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

test("public, organizer and back-office surfaces fit small and large screens", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.includes("..")) throw new Error("Invalid path");
      const data = await readFile(new URL(`..${path === "/" ? "/index.html" : path}`, import.meta.url));
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage();
    await page.route("https://**", route => route.fulfill({ body: "" }));
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const wedding = { id, slug: "qa-couple", couple_names: "QA Couple", wedding_date: "2099-12-12",
      currency: "KES", public_location: "Nairobi", published_at: "2026-01-01", palette: ["#ffffff", "#ffff00"],
      attire_notes: "Traditional or formal - wear what feels comfortable.", venues: [], registry: [], tiers: [] };
    const guest = { rsvp_id: id, wedding_id: id, slug: wedding.slug, couple_names: wedding.couple_names,
      guest_name: "QA Guest", attendance_status: "yes" };
    let staffRole = "owner";
    await page.route("https://open.er-api.com/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
      result: "success", base_code: "USD", rates: { USD: 1, KES: 130 }, time_last_update_utc: new Date().toUTCString()
    }) }));
    await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", r: "owner", user: { email: "qa@example.test" } })));
    await page.route("https://cdnjs.cloudflare.com/**", route => route.fulfill({ contentType: "text/javascript", body: "window.QRCode=class {static CorrectLevel={H:2};}" }));
    await page.route("**/api/**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      assert.equal(route.request().method(), "GET", "layout review never submits forms, emails or payments");
      let data = {};
      if (action === "get") data = { wedding };
      if (action === "list") data = { weddings: [wedding] };
      if (action === "site") data = { wedding };
      if (action === "wedding") data = wedding;
      if (action === "verify-qr") data = { guest };
      if (action === "role") data = { role: staffRole };
      if (action === "overview") data = { weddings: 1, published: 1, archived: 0, past: 0, users: 1, admins: 1, rsvps: 1, bids: 0, pending_payouts: 0, test_payments: 0,
        collected_by_currency: { KES: 13000, USD: 100 } };
      if (action === "operations") data = { queue: { counts: {} } };
      if (action === "policies") data = { policies: {} };
      if (action === "options") data = { providers: [], paymentAvailable: false };
      if (action === "quote") data = { quote: { fee_minor: 5000, currency: "KES", reason: "Sample far-future fee." } };
      if (action === "publication-options") data = { quote: { fee_minor: 5000, currency: "KES", reason: "Sample far-future fee." }, methods: [], checkout: null, testMode: true };
      if (action === "payment-controls") data = { enabled: ["daraja", "paystack"],
        providers: [{ id: "daraja", configured: true }, { id: "paystack", configured: true }, { id: "stripe", configured: false }] };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    const pages = ["index.html", "signin.html", "dashboard.html", `wedding.html?id=${id}`,
      "account.html", "admin.html", "owner.html", `verify.html?code=${id}`,
      `ecard.html?slug=qa-couple&guest_id=${id}`, "privacy.html", "terms.html"];
    for (const surface of pages) {
      await page.goto(`http://127.0.0.1:${server.address().port}/${surface}`, { waitUntil: "domcontentloaded" });
      if (surface.startsWith("wedding.html")) await page.locator("#edit-section").waitFor({ state: "visible" });
      if (surface === "admin.html" || surface === "owner.html") await page.locator(".stat-card").first().waitFor();
      for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        const metrics = await page.evaluate(() => ({
          width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
          topLinks: [...document.querySelectorAll(".top a, .top button, .site-header a, .bo-nav button")]
            .filter(el => el.getClientRects().length).map(el => {
              const r = el.getBoundingClientRect(); return { text: el.textContent, left: r.left, right: r.right };
            }),
          overflowing: [...document.querySelectorAll("body *")].filter(el => {
            const r = el.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1);
          }).slice(0, 8).map(el => `${el.tagName}#${el.id}.${el.className}`)
        }));
        assert.ok(metrics.scroll <= metrics.width, `${surface} at ${width}: ${JSON.stringify(metrics)}`);
        for (const link of metrics.topLinks) assert.ok(link.left >= 0 && link.right <= width, `${surface}: ${link.text} visible at ${width}`);
        if (process.env.WEDDING_SCREENSHOTS) await page.screenshot({
          path: join(process.env.WEDDING_SCREENSHOTS, `refinement-${surface.split(".")[0]}-${width}.png`),
          fullPage: !surface.startsWith("wedding.html")
        });
      }
    }
    wedding.published_at = null;
    await page.goto(`http://127.0.0.1:${server.address().port}/wedding.html?id=${id}`, { waitUntil: "domcontentloaded" });
    await page.locator("#edit-section").waitFor({ state: "visible" });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.click("#edit-colors-btn");
    const paletteFits = await page.locator("#color-inputs").evaluate(el => el.scrollWidth <= el.clientWidth);
    assert.ok(paletteFits, "palette name/hex controls wrap on mobile");
    await page.locator("#pay-fee-btn").click();
    await page.waitForFunction(() => document.getElementById("publication-status").textContent.includes("No configured test payment method"));
    assert.ok(await page.locator("#publication-submit").isDisabled(), "editor fails closed without a configured publication method");
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      assert.ok(await page.locator("#publication-dialog").evaluate(el => {
        const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth;
      }), `integrated editor publication dialog fits ${width}`);
    }
    await page.locator("#publication-close").click();
    for (const surface of ["admin.html", "owner.html"]) {
      await page.goto(`http://127.0.0.1:${server.address().port}/${surface}`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-tab="fees"]').click();
      await page.locator("#payment-controls-form").waitFor();
      assert.equal(await page.locator('#payment-controls-form input:checked').count(), 2);
      assert.ok(await page.locator('#payment-controls-form button').isEnabled(), "Admin and Owner can save independent method controls");
      for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${surface}: payment controls fit ${width}`);
      }
    }
    for (staffRole of ["admin", "superadmin"]) {
      await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`, { waitUntil: "domcontentloaded" });
      await page.locator("#admin-nav button").first().waitFor();
      const tabs = await page.locator("#admin-nav button").evaluateAll(nodes => nodes.map(n => n.dataset.tab));
      if (staffRole === "admin") {
        assert.deepEqual(tabs, ["operations", "weddings", "users"]);
        assert.equal(await page.locator('[data-tab="overview"]').count(), 0);
      } else {
        assert.ok(tabs.includes("overview") && tabs.includes("audit") && tabs.includes("fees"));
        await page.waitForFunction(() => document.getElementById("panel").textContent.includes("≈"));
        assert.match(await page.locator("#panel").innerText(), /USD|US\$/);
        assert.match(await page.locator("#panel").innerText(), /KES|Ksh/);
        await page.locator('[data-tab="fees"]').click();
        await page.locator("#fees-form").waitFor();
        assert.ok(await page.locator("#p-fee").isDisabled());
        assert.ok(await page.locator("#refund-allocation").isDisabled());
        assert.ok(await page.locator("#payment-controls-form button").isEnabled());
      }
    }
  } finally {
    await browser?.close();
    server.close();
  }
});
