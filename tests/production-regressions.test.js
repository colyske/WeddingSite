import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    const filename = pathname === "/" ? "index.html" : pathname.slice(1);
    if (filename.includes("..")) throw new Error("invalid path");
    const content = await readFile(join(root, filename));
    res.writeHead(200, { "Content-Type": types[extname(filename)] || "application/octet-stream" }).end(content);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
for (const options of [{ channel: "msedge" }, {}]) {
  try { browser = await chromium.launch(options); break; } catch { /* Try the next installed browser. */ }
}
const skip = browser ? false : "No Chromium/Edge is installed.";

const couple = "Atieno & Otieno";
const rsvpId = "45e4afbe-fc9f-4d14-aac9-98e84d9e54ea";
const weddingId = "550e8400-e29b-41d4-a716-446655440000";
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const wedding = {
  id: weddingId,
  slug: "atieno-and-otieno",
  couple_names: couple,
  welcome_story: "Love, family & friendship <together>.",
  wedding_date: `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`,
  public_location: "Nairobi",
  currency: "KES",
  max_guest_capacity: 150,
  palette: ["#244b3a", "#a9b5a2"],
  attire_notes: "Formal African elegance",
  venues: [{ id: "venue-id", name: "Garden & Hall", event_time: "12:30:00", map_link: "https://maps.example.test/venue", description: "Church & reception", is_main: true }],
  registry: [{ id: "registry-id", name: "Home & Honeymoon", category: "Travel", description: "Start our life together", target_amount_minor: 500000, notes: "Thank you", amount_raised_minor: 20000 }],
  tiers: [{ id: "tier-id", name: "Gold & Friends", min_amount_minor: 500000, perks: "Brand recognition" }],
  vip: { id: "vip-id", title: "VIP seating", description: "Reserved section", price_minor: 250000, seats_total: 12, seats_sold: 2 },
  payout: { method: "mpesa", display_mask: "", verified: false },
  published_at: "2026-01-01T00:00:00Z"
};

async function installQrStub(page) {
  await page.route("https://cdnjs.cloudflare.com/**/qrcode.min.js", route => route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: "window.QRCode = class { constructor(el, options) { el.dataset.qrText = options.text; } }; window.QRCode.CorrectLevel = { H: 2 };"
  }));
}

test("public guest, RSVP, bid, e-card, verification, and editor regressions", { skip }, async t => {
  if (!browser) {
    if (process.env.CI) throw new Error(skip);
    t.skip(skip);
    return;
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const apiCalls = [];
    await installQrStub(page);
    await page.route("**/api/guest**", async route => {
      const url = new URL(route.request().url());
      const action = url.searchParams.get("action");
      const method = route.request().method();
      apiCalls.push({ action, method });
      const body = route.request().postDataJSON?.() || {};
      let payload = {};
      if (action === "site" || action === "wedding") payload = action === "site" ? { wedding } : wedding;
      if (action === "leaderboard") payload = { bids: [{ song_title: "Home & Away", artist_name: "Artist <One>", bid_amount_minor: 450000, currency: "KES" }] };
      if (action === "ledger") payload = { ledger: [] };
      if (action === "fundraising") payload = { tiers: [{ name: "Gold & Friends", min_amount_minor: 500000, perks: "Brand recognition" }], vip: { title: "VIP seating", description: "Reserved section", price_minor: 250000, seats_total: 12, seats_sold: 2 }, sponsors: [{ company_name: "Acme & Co", amount_minor: 100000, website: "https://example.test", contact_phone: "+254700000000" }] };
      if (action === "rsvp-count") payload = { count: 0 };
      if (action === "rsvp" && method === "POST") payload = { message: "Your attendance is confirmed.", status: "confirmed", rsvpId };
      if (action === "bid" && method === "POST") payload = { message: "Your bid is on the leaderboard." };
      if (action === "verify-qr" && method === "GET") payload = { guest: { rsvp_id: rsvpId, wedding_id: weddingId, slug: wedding.slug, couple_names: couple, guest_name: "Guest & Friend", attendance_status: "yes", checked_in_at: null } };
      if (action === "verify-qr" && method === "POST") payload = { checked_in: true, guest: { rsvp_id: rsvpId, wedding_id: weddingId, slug: wedding.slug, couple_names: couple, guest_name: "Guest & Friend", attendance_status: "yes", checked_in_at: "2026-01-01T12:00:00Z" } };
      if (action === "rsvp" && method === "POST") {
        assert.equal(body.guestName, "Atieno & Otieno");
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto(`${base}/guest.html?slug=${wedding.slug}`);
    await page.waitForFunction(() => document.querySelector("#couple-names")?.textContent === "Atieno & Otieno");
    assert.equal(await page.title(), `${couple} — Wedding`);
    assert.equal(await page.locator("#welcome-story").textContent(), wedding.welcome_story);
    assert.equal(await page.locator("#countdown").isVisible(), true);
    assert.ok(await page.locator("#countdown").evaluate(el =>
      [...el.querySelectorAll(".countdown-value")].reduce((sum, node) => sum * 60 + Number(node.textContent), 0) > 0
    ));
    assert.match(await page.locator("#leaderboard-body").textContent(), /Artist <One>/);
    assert.match(await page.locator("#tiers-display").textContent(), /Gold & Friends/);
    assert.match(await page.locator("#vip-display").textContent(), /VIP seating/);
    assert.match(await page.locator("#sponsors-display").textContent(), /Acme & Co/);

    await page.fill("#guest-name", couple);
    await page.fill("#guest-phone", "0712345678");
    await page.selectOption("#attending", "yes");
    await page.click('#rsvp-form button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector("#ecard").hidden);
    assert.equal(await page.locator("#ecard-guest-name").textContent(), couple);
    assert.equal(await page.locator("#pass-status").textContent(), "Attendance confirmed");
    assert.equal(await page.locator("#qrcode").getAttribute("data-qr-text"), `${base}/verify.html?code=${rsvpId}`);
    assert.equal(await page.locator("#standalone-pass-link").getAttribute("href"), `${base}/ecard.html?slug=${wedding.slug}&guest_id=${rsvpId}`);
    assert.match(await page.locator("#notice").textContent(), /RSVP received/);
    await page.fill("#song-title", "Home & Away");
    await page.fill("#artist", "Artist & Friend");
    await page.fill("#bid-amount", "4500");
    await page.click('#bid-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("Bid placed"));
    assert.ok(apiCalls.some(call => call.action === "bid" && call.method === "POST"));

    const verification = await context.newPage();
    const verificationCalls = [];
    await verification.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", r: "client" })));
    await verification.route("**/api/guest**", async route => {
      const method = route.request().method();
      verificationCalls.push(method);
      const guest = {
        rsvp_id: rsvpId,
        wedding_id: weddingId,
        slug: wedding.slug,
        couple_names: couple,
        guest_name: "Guest & Friend",
        attendance_status: "yes",
        checked_in_at: method === "POST" ? "2026-01-01T12:00:00Z" : null
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(method === "POST" ? { checked_in: true, guest } : { guest })
      });
    });
    await verification.goto(`${base}/verify.html?code=${rsvpId}`);
    await verification.waitForFunction(() => !document.querySelector("#guest-details").hidden);
    assert.equal(await verification.locator("#guest-name").textContent(), "Guest & Friend");
    verification.on("dialog", dialog => dialog.accept());
    await verification.click("#check-in");
    await verification.waitForFunction(() => document.querySelector("#checkin-status").textContent.includes("Checked in at"));
    assert.ok(verificationCalls.includes("POST"));
    await context.close();

    const editorContext = await browser.newContext();
    const editor = await editorContext.newPage();
    let savedBody;
    const loadedPalettes = [];
    let storedWedding = { ...wedding, published_at: null };
    await editor.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", r: "client" })));
    await editor.route("**/api/weddings**", async route => {
      const url = new URL(route.request().url());
      const action = url.searchParams.get("action");
      let data = {};
      if (action === "get") {
        loadedPalettes.push([...storedWedding.palette]);
        data = { wedding: storedWedding };
      }
      if (action === "payout-methods") data = { methods: [{ id: "mpesa", name: "M-Pesa" }] };
      if (action === "update") {
        savedBody = route.request().postDataJSON();
        storedWedding = {
          ...storedWedding,
          couple_names: savedBody.coupleNames,
          welcome_story: savedBody.welcomeStory,
          public_location: savedBody.location,
          wedding_date: savedBody.weddingDate,
          currency: savedBody.currency,
          max_guest_capacity: savedBody.maxCapacity,
          palette: savedBody.palette,
          attire_notes: savedBody.attireNotes,
          venues: savedBody.venues.map(venue => ({ ...venue, event_time: venue.eventTime, map_link: venue.mapLink, is_main: venue.isMain })),
          registry: savedBody.registry.map(item => ({ ...item, target_amount_minor: item.targetAmount * 100 })),
          tiers: savedBody.tiers.map(tier => ({ ...tier, min_amount_minor: tier.minAmount * 100 })),
          vip: savedBody.vip.price ? { ...savedBody.vip, price_minor: savedBody.vip.price * 100, seats_total: savedBody.vip.seats } : null,
          payout: savedBody.payoutDetails ? { method: savedBody.payoutDetails.method, display_mask: "", verified: false } : storedWedding.payout
        };
        data = { wedding: storedWedding };
      }
      if (action === "publish") {
        storedWedding.published_at = "2026-01-01T00:00:00Z";
        data = { published: true, wedding: storedWedding };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    });
    await editor.goto(`${base}/wedding.html?id=${weddingId}`);
    await editor.waitForFunction(() => !document.querySelector("#edit-section").hidden);
    await editor.click("#account-menu-btn");
    assert.equal(await editor.locator('a[href="/account.html"]').isVisible(), true);
    assert.equal(await editor.locator("#payment-mpesa").count(), 0);
    await editor.fill("#welcome-story", "Atieno & Otieno <forever>.");
    await editor.click("#edit-colors-btn");
    await editor.locator(".palette-color-hex").first().fill("#123abc");
    await editor.locator(".palette-color-hex").first().dispatchEvent("change");
    await editor.click("#apply-colors-btn");
    await editor.click('#edit-form button[type="submit"]');
    await editor.waitForFunction(() => document.querySelector("#notice").textContent.includes("Changes saved"));
    assert.deepEqual(savedBody.palette, ["#123abc", "#a9b5a2"]);
    assert.deepEqual(storedWedding.palette, ["#123abc", "#a9b5a2"]);
    assert.equal(savedBody.venues[0].name, "Garden & Hall");
    assert.equal(savedBody.welcomeStory, "Atieno & Otieno <forever>.");
    assert.equal(savedBody.attireNotes, "Formal African elegance");
    assert.equal(savedBody.registry[0].name, "Home & Honeymoon");
    assert.equal(savedBody.tiers[0].name, "Gold & Friends");
    assert.equal(savedBody.vip.title, "VIP seating");
    assert.deepEqual(savedBody.payoutDetails, { method: "mpesa", fields: {}, verified: false });
    await editor.reload();
    await editor.waitForFunction(() => !document.querySelector("#edit-section").hidden);
    assert.equal(await editor.locator("#welcome-story").inputValue(), "Atieno & Otieno <forever>.");
    assert.equal(await editor.locator(".venue-name").first().inputValue(), "Garden & Hall");
    assert.equal(await editor.locator("#attire-notes").inputValue(), "Formal African elegance");
    assert.equal(await editor.locator(".registry-name").first().inputValue(), "Home & Honeymoon");
    assert.equal(await editor.locator(".tier-name").first().inputValue(), "Gold & Friends");
    assert.equal(await editor.locator("#vip-title").inputValue(), "VIP seating");
    assert.equal(await editor.locator("#payout-method").inputValue(), "mpesa");
    assert.deepEqual(loadedPalettes.at(-1), ["#123abc", "#a9b5a2"], JSON.stringify(loadedPalettes));
    assert.deepEqual(await editor.locator("#palette-preview").evaluate(el => JSON.parse(el.dataset.palette)), ["#123abc", "#a9b5a2"]);
    await editor.click("#publish-btn");
    await editor.click("#confirm-publish");
    await editor.waitForFunction(() => !document.querySelector("#published-section").hidden);
    assert.equal(await editor.locator("#view-guest-site").getAttribute("target"), "_blank");
    assert.equal(await editor.locator("#view-guest-site").getAttribute("href"), `${base}/guest.html?slug=${wedding.slug}`);
    await editorContext.close();
  } finally {
    await browser.close();
    server.close();
  }
});
