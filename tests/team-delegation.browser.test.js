import test, { after } from "node:test";
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
const weddingId = "52000000-0000-4000-8000-000000000001";

after(async () => {
  await browser?.close();
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await closed;
});

async function authenticatedPage(context) {
  await context.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({
    a: "test-session-token",
    r: "",
    role: "client",
    user: { id: "51000000-0000-4000-8000-000000000001", email: "couple@example.test" }
  })));
  const page = await context.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  return page;
}

test("owner can create a copyable invite link without sending an email", { skip }, async t => {
  if (!browser) {
    if (process.env.CI) throw new Error(skip);
    t.skip(skip);
    return;
  }
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await authenticatedPage(context);
  let createdInvite = null;
  let updatedExpiry = null;
  const calls = [];
  await page.route("**/api/team**", async route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get("action");
    calls.push({ action, method: route.request().method() });
    if (action === "committee-list") return route.fulfill({ json: { records: [] } });
    if (action === "manage") {
      return route.fulfill({ json: { team: {
        invites: createdInvite ? [createdInvite] : [],
        members: [{ user_id: "member-id", display_name: "Existing helper", roles: ["checkin", "usher"],
          grants: [{ role: "checkin", expires_at: "2099-01-02T00:00:00Z" }, { role: "usher", expires_at: null }] }]
      } } });
    }
    if (action === "invite") {
      const body = route.request().postDataJSON();
      assert.equal(body.expiryMode, "custom");
      assert.ok(new Date(body.grantExpiresAt).getTime() > Date.now());
      createdInvite = { id: "invite-id", role: body.role, invitee_email: body.email, expires_at: "2099-01-01T00:00:00Z" };
      return route.fulfill({ status: 201, json: {
        inviteId: createdInvite.id,
        inviteLink: "/team-invite.html?token=abcdefghijklmnopqrstuvwxyzABCDEFG0123456789_-",
        delivery: "link_created_not_sent",
        expiresInDays: 7
      } });
    }
    if (action === "set-expiry") {
      updatedExpiry = route.request().postDataJSON();
      return route.fulfill({ json: { updated: true } });
    }
    throw new Error(`Unexpected team action: ${action}`);
  });

  await page.goto(`${base}/team.html?weddingId=${weddingId}`);
  await page.waitForFunction(() => document.querySelector("#manage-panel")?.hidden === false);
  await page.fill("#invite-email", "usher@example.test");
  await page.selectOption("#invite-role", "usher");
  await page.selectOption("#invite-expiry-mode", "custom");
  await page.fill("#invite-grant-expiry", "2099-01-01T12:00");
  await page.click('#invite-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#invite-link-box")?.hidden === false);
  assert.match(await page.locator("#invite-delivery").textContent(), /created, not sent/i);
  assert.match(await page.locator("#invite-link").inputValue(), /team-invite\.html\?token=/);
  assert.match(await page.locator("#pending-invites").textContent(), /usher@example\.test[\s\S]*Usher/);
  assert.match(await page.locator("#team-members").textContent(), /Existing helper[\s\S]*Entrance check-in, Usher/);
  assert.ok(calls.some(call => call.action === "invite" && call.method === "POST"));
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  await page.selectOption('[data-member-expiry] select', "none");
  await page.click('[data-member-expiry] button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#team-notice")?.textContent === "Helper access expiry updated.");
  assert.deepEqual(updatedExpiry, { weddingId, userId: "member-id", expiryMode: "none" });
});

test("an invite preview shows the role but accepts only after an explicit POST", { skip }, async t => {
  if (!browser) {
    if (process.env.CI) throw new Error(skip);
    t.skip(skip);
    return;
  }
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await authenticatedPage(context);
  let accepted = 0;
  const apiCalls = [];
  await page.route("**/api/team**", async route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get("action");
    apiCalls.push({ action, method: route.request().method() });
    if (action === "invite-details") {
      return route.fulfill({ json: { invite: {
        wedding_id: weddingId,
        couple_names: "Couple One",
        role: "checkin",
        invitee_email: "helper@example.test",
        expires_at: "2099-01-01T00:00:00Z",
        grant_expires_at: "2099-01-02T00:00:00Z"
      } } });
    }
    if (action === "accept") {
      accepted += 1;
      return route.fulfill({ json: { accepted: { wedding_id: weddingId, couple_names: "Couple One", role: "checkin" } } });
    }
    throw new Error(`Unexpected team action: ${action}`);
  });

  await page.goto(`${base}/team-invite.html?token=${"A".repeat(43)}`);
  await page.waitForFunction(() => document.querySelector("#invite-details")?.hidden === false);
  assert.match(await page.locator("#invite-wedding").textContent(), /Couple One/);
  assert.match(await page.locator("#invite-role").textContent(), /Entrance check-in/);
  assert.match(await page.locator("#grant-expiry").textContent(), /2099/);
  assert.equal(accepted, 0);
  assert.ok(apiCalls.every(call => call.method === "GET"));
  await page.click("#accept-invite");
  await page.waitForFunction(() => document.querySelector("#open-team")?.hidden === false);
  assert.equal(accepted, 1);
  assert.ok(apiCalls.some(call => call.action === "accept" && call.method === "POST"));
});

test("usher workspace renders only the assigned seating view", { skip }, async t => {
  if (!browser) {
    if (process.env.CI) throw new Error(skip);
    t.skip(skip);
    return;
  }
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await authenticatedPage(context);
  await page.route("**/api/team**", async route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    if (action === "manage") return route.fulfill({ status: 403, json: { error: "Only the couple can manage this wedding team." } });
    if (action === "workspace") return route.fulfill({ json: { workspace: {
      roles: ["usher"],
      can_check_in: false,
      guests: [{ name: "Riley Guest", table_number: "Table 4", rsvp_status: "yes", checked_in: false }],
      rsvp_support: [],
      playlist: []
    } } });
    throw new Error(`Unexpected team action: ${action}`);
  });

  await page.goto(`${base}/team.html?weddingId=${weddingId}`);
  await page.waitForFunction(() => document.querySelector("#helper-panel")?.hidden === false);
  assert.match(await page.locator("#usher-roster").textContent(), /Riley Guest[\s\S]*Table 4[\s\S]*No/);
  assert.equal(await page.locator("#checkin-tools").isVisible(), false);
  assert.equal(await page.locator("#rsvp-tools").isVisible(), false);
  assert.equal(await page.locator("#dj-tools").isVisible(), false);
  assert.equal(await page.locator("#committee-panel").isVisible(), false);
});

test("committee record and review remain separate from the public wedding editor", { skip }, async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await authenticatedPage(context);
  let records = [];
  const actions = [];
  await page.route("**/api/team**", async route => {
    const action = new URL(route.request().url()).searchParams.get("action");
    actions.push(action);
    if (action === "manage") return route.fulfill({ json: { team: { invites: [], members: [] } } });
    if (action === "committee-list") return route.fulfill({ json: { records } });
    if (action === "committee-create") {
      const body = route.request().postDataJSON();
      records = [{ id: "52000000-0000-4000-8000-000000000002", meeting_date: body.meetingDate,
        committee: body.committee, notes: body.notes, decision: body.decision, action_owner: body.owner,
        due_date: body.dueDate, category: body.category, suggestion: body.suggestion, review_status: "pending", task_done: false }];
      return route.fulfill({ status: 201, json: { id: records[0].id } });
    }
    if (action === "committee-review") {
      records[0].review_status = route.request().postDataJSON().status;
      return route.fulfill({ json: { updated: true } });
    }
    throw new Error(`Unexpected team action: ${action}`);
  });
  let weddingCalls = 0;
  await page.route("**/api/weddings**", route => { weddingCalls++; return route.abort(); });
  await page.goto(`${base}/team.html?weddingId=${weddingId}`);
  await page.waitForFunction(() => document.querySelector("#committee-records")?.textContent.includes("No committee records"));
  await page.fill('[name="meetingDate"]', "2026-11-19");
  await page.fill('[name="committee"]', "Planning");
  await page.fill('[name="notes"]', "Private minutes");
  await page.fill('[name="suggestion"]', "Guest wording");
  await page.click('#committee-form button[type="submit"]');
  await page.locator('[data-review][data-status="approved"]').click();
  await page.waitForFunction(() => document.querySelector("#committee-records")?.textContent.includes("(approved)"));
  assert.match(await page.locator("#team-notice").textContent(), /guest site has not changed/i);
  assert.equal(await page.locator("[data-approved-wording]").inputValue(), "Guest wording");
  assert.equal(await page.locator("#committee-records a").getAttribute("href"), `/wedding.html?id=${weddingId}`);
  assert.match(await page.locator("#committee-records").textContent(), /published wedding can update the guest site immediately/i);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedWording = text; } } }); });
  await page.click("[data-copy-wording]");
  assert.equal(await page.evaluate(() => window.copiedWording), "Guest wording");
  assert.equal(weddingCalls, 0);
  assert.ok(actions.includes("committee-create") && actions.includes("committee-review"));

  const editorRequests = [];
  await page.unroute("**/api/weddings**");
  await context.route("**/api/**", async route => {
    const request = route.request();
    const action = new URL(request.url()).searchParams.get("action");
    editorRequests.push({ action, method: request.method() });
    const wedding = {
      id: weddingId, slug: "test-wedding", couple_names: "Test Couple", wedding_date: "2027-03-20", currency: "USD",
      welcome_story: "Original welcome", time_zone: "UTC", palette: [], palette_names: [], tiers: [], registry: [],
      published_at: "2026-01-01T00:00:00Z", payout: { method: "bank" },
      venues: [{ id: "00000000-0000-0000-0000-000000000001", name: "Garden Hall", event_date: "2027-03-20",
        event_time: "14:00", address: "1 Garden Road", kind: "ceremony", is_main: true }]
    };
    let data = {};
    if (action === "get") data = { wedding, amountPresetMaxMinor: 100000000 };
    if (action === "collection-capabilities") data = { currencies: [{ code: "USD", name: "US Dollar", methods: [{ name: "Card", markets: ["United States"] }] }] };
    if (action === "payout-methods") data = { methods: [{ value: "bank", label: "Bank transfer" }] };
    if (action === "quote") data = { quote: { fee_minor: 0, currency: "USD" } };
    if (action === "campaigns") data = { currency: "USD", campaigns: [], summary: [], rows: [] };
    if (action === "extras-get") data = { faq: [], travel: "" };
    return route.fulfill({ json: data });
  });
  await page.getByRole("link", { name: "Open wedding editor" }).click();
  await page.locator("#edit-section").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).searchParams.get("id"), weddingId);
  assert.equal(await page.locator("#welcome-story").inputValue(), "Original welcome");
  await page.locator("#welcome-story").fill("Guest wording");
  assert.equal(await page.locator("#welcome-story").inputValue(), "Guest wording");
  assert.ok(editorRequests.some(request => request.action === "get" && request.method === "GET"));
  assert.equal(editorRequests.filter(request => request.method !== "GET").length, 0, "Opening and editing must not save or publish");
});
