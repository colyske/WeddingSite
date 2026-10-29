import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("authenticated correction and staff reason/review surfaces never auto-publish", async () => {
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
    const deployedBase = process.env.WEDDING_MODERATION_BASE_URL;
    if (deployedBase && !/^https:\/\/[^/?#]+\/?$/.test(deployedBase)) throw new Error("Use an HTTPS origin for WEDDING_MODERATION_BASE_URL.");
    if (!deployedBase) await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = deployedBase ? new URL(deployedBase).origin : `http://127.0.0.1:${server.address().port}`;
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const loadedScripts = new Set();
    page.on("response", response => {
      if (response.ok() && response.request().resourceType() === "script") loadedScripts.add(new URL(response.url()).pathname);
    });
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const c = { id, wedding_id: id, reason_code: "inaccurate_details", reason: "The <venue> address needs correction.",
      required_action: "Correct the venue address and map.", status: "open", revision: 1, was_published: true,
      couple_names: "Local couple", history: [{ actor: "staff", event: "opened", note: "Address needs correction." }] };
    const wedding = { id, slug: "local-couple", couple_names: "Local couple", currency: "KES", wedding_date: "2099-12-12",
      public_location: "Nairobi", lifecycle_admin_restricted: true, unpublished_at: "2026-01-01", moderation: c,
      venues: [], registry: [], tiers: [], palette: ["#ffffff"], time_zone: "Africa/Nairobi" };
    const posts = [];
    await page.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === base && ["GET", "HEAD"].includes(request.method()) && !url.pathname.startsWith("/api/")) return route.continue();
      return route.fulfill({ body: "" });
    });
    await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "fixture", r: "client" })));
    await page.route("**/api/**", async route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      const body = route.request().postDataJSON();
      let data = {};
      if (route.request().method() === "POST") {
        posts.push({ action, body });
        if (action === "moderation-correction") {
          assert.equal(body.expectedRevision, 1);
          c.status = "submitted"; c.revision = 2; c.client_response = body.note;
        } else if (action === "update") {
          const { moderation, ...savedWedding } = wedding;
          data = { wedding: savedWedding };
        } else if (action === "wedding-action") {
          assert.equal(body.action, "archive");
          assert.ok(body.reason.length >= 15 && body.required_action.length >= 10);
        } else if (action === "moderation-review") {
          assert.equal(body.expected_revision, 2);
          assert.equal(body.decision, "return");
          c.status = "returned"; c.revision = 3; c.staff_note = body.note;
        } else throw new Error("Unexpected mutation: " + action);
      }
      if (action === "get") data = { wedding };
      if (action === "role") data = { role: "admin" };
      if (action === "operations") data = { queue: { counts: {} } };
      if (action === "moderation") data = { cases: [c] };
      if (action === "weddings") data = { weddings: [{ ...wedding, published_at: "2026-01-01" }] };
      if (action === "quote") data = { quote: { fee_minor: 0, currency: "KES" } };
      if (action === "withdrawals") data = { withdrawals: [{ id, status: "cancelled", amount_minor: 1000, currency: "KES",
        requested_at: "2026-01-01", staff_reason: "Correct the payout account details." }] };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(`${base}/wedding.html?id=${id}`, { waitUntil: "domcontentloaded" });
    await page.locator("#moderation-form").waitFor({ state: "visible" });
    await page.locator("#edit-section").waitFor({ state: "visible" });
    await page.locator("#withdrawals-body").getByText("Correct the payout account details.").waitFor();
    assert.match(await page.locator("#moderation-details").innerText(), /<venue>/, "reasons rendered as text, not markup");
    assert.ok(await page.locator("#publish-btn").isHidden());
    await page.locator("#edit-form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => document.getElementById("notice").textContent === "Changes saved.");
    assert.ok(await page.locator("#moderation-form").isVisible(), "saving corrections retains the moderation response form");
    await page.locator("#moderation-note").fill("I corrected the address and the map.");
    await page.locator("#moderation-submit").click();
    await page.waitForFunction(() => document.getElementById("moderation-status").textContent.includes("Correction submitted"));
    assert.ok(await page.locator("#moderation-form").isHidden());
    assert.ok(await page.locator("#publish-btn").isHidden());
    await page.goto(`${base}/admin.html`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-moderation-review]").waitFor();
    await page.locator('[data-moderation-review] select[name="decision"]').selectOption("return");
    await page.locator('[data-moderation-review] textarea').fill("Please also correct the venue name.");
    page.on("dialog", dialog => dialog.accept());
    await page.locator('[data-moderation-review] button').click();
    await page.waitForFunction(() => document.getElementById("panel").textContent.includes("returned"));
    await page.locator('[data-tab="weddings"]').click();
    await page.locator('[data-wa="archive"]').click();
    await page.locator('#restriction-form [name="reason"]').fill("The displayed venue name is inaccurate.");
    await page.locator('#restriction-form [name="required_action"]').fill("Correct the venue name and submit your changes.");
    await page.locator('#restriction-form button').click();
    await page.waitForFunction(() => !document.getElementById("restriction-form"));
    assert.deepEqual(posts.map(p => p.action), ["update", "moderation-correction", "moderation-review", "wedding-action"]);
    for (const script of ["/auth-client.js", "/backoffice.js"]) assert.ok(loadedScripts.has(script), `real asset loaded: ${script}`);
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${base}/wedding.html?id=${id}`, { waitUntil: "domcontentloaded" });
      await page.locator("#moderation-form").waitFor({ state: "visible" });
      assert.ok(await page.locator("#moderation-box").evaluate(el => el.scrollWidth <= el.clientWidth), `moderation fits ${width}`);
    }
  } finally { await browser?.close(); server.close(); }
});
