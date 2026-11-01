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
  const calls = [];
  await page.route("**/api/team**", async route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get("action");
    calls.push({ action, method: route.request().method() });
    if (action === "manage") {
      return route.fulfill({ json: { team: {
        invites: createdInvite ? [createdInvite] : [],
        members: [{ user_id: "member-id", display_name: "Existing helper", roles: ["checkin", "usher"] }]
      } } });
    }
    if (action === "invite") {
      const body = route.request().postDataJSON();
      createdInvite = { id: "invite-id", role: body.role, invitee_email: body.email, expires_at: "2099-01-01T00:00:00Z" };
      return route.fulfill({ status: 201, json: {
        inviteId: createdInvite.id,
        inviteLink: "/team-invite.html?token=abcdefghijklmnopqrstuvwxyzABCDEFG0123456789_-",
        delivery: "link_created_not_sent",
        expiresInDays: 7
      } });
    }
    throw new Error(`Unexpected team action: ${action}`);
  });

  await page.goto(`${base}/team.html?weddingId=${weddingId}`);
  await page.waitForFunction(() => document.querySelector("#manage-panel")?.hidden === false);
  await page.fill("#invite-email", "usher@example.test");
  await page.selectOption("#invite-role", "usher");
  await page.click('#invite-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#invite-link-box")?.hidden === false);
  assert.match(await page.locator("#invite-delivery").textContent(), /created, not sent/i);
  assert.match(await page.locator("#invite-link").inputValue(), /team-invite\.html\?token=/);
  assert.match(await page.locator("#pending-invites").textContent(), /usher@example\.test[\s\S]*Usher/);
  assert.match(await page.locator("#team-members").textContent(), /Existing helper[\s\S]*Entrance check-in, Usher/);
  assert.ok(calls.some(call => call.action === "invite" && call.method === "POST"));
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
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
        expires_at: "2099-01-01T00:00:00Z"
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
});
