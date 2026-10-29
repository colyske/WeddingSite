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
      if (action === "role") data = { role: "owner" };
      if (action === "overview") data = { weddings: 1, published: 1, archived: 0, past: 0, users: 1, admins: 1, rsvps: 1, bids: 0, pending_payouts: 0, test_payments: 0 };
      if (action === "operations") data = { queue: { counts: {} } };
      if (action === "options") data = { providers: [], paymentAvailable: false };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    const pages = ["index.html", "signin.html", "dashboard.html", `wedding.html?id=${id}`,
      "account.html", "admin.html", "owner.html", `verify.html?code=${id}`,
      `ecard.html?slug=qa-couple&guest_id=${id}`, "privacy.html", "terms.html"];
    for (const surface of pages) {
      await page.goto(`http://127.0.0.1:${server.address().port}/${surface}`);
      if (surface.startsWith("wedding.html")) await page.locator("#edit-section").waitFor({ state: "visible" });
      if (surface === "admin.html" || surface === "owner.html") await page.locator(".stat-card").first().waitFor();
      for (const width of [320, 375, 1280]) {
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
    await page.goto(`http://127.0.0.1:${server.address().port}/wedding.html?id=${id}`);
    await page.locator("#edit-section").waitFor({ state: "visible" });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.click("#edit-colors-btn");
    const paletteFits = await page.locator("#color-inputs").evaluate(el => el.scrollWidth <= el.clientWidth);
    assert.ok(paletteFits, "palette name/hex controls wrap on mobile");
  } finally {
    await browser?.close();
    server.close();
  }
});
