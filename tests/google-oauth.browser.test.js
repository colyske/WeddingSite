import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  try {
    const filename = pathname === "/" ? "index.html" : pathname.slice(1);
    if (filename.includes("..")) throw new Error("Invalid path.");
    const content = await readFile(join(root, filename));
    res.writeHead(200, { "Content-Type": contentTypes[extname(filename)] || "application/octet-stream" }).end(content);
  } catch {
    res.writeHead(404).end("Not found.");
  }
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
for (const options of [{ channel: "msedge" }, {}]) {
  try { browser = await chromium.launch(options); break; } catch { /* Try the next installed browser. */ }
}
const skip = browser ? false : "No Chromium/Edge is installed.";

test("Google sign-in completes PKCE and returns only to a safe same-origin destination", { skip }, async t => {
  if (!browser) {
    if (process.env.CI) throw new Error(skip);
    t.skip(skip);
    return;
  }
  const page = await browser.newPage();
  let exchangeBody;
  await page.route("**/api/auth?action=google-status", route =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) }));
  await page.route("**/api/auth?action=google-start", async route => {
    const body = route.request().postDataJSON();
    const authorization = new URL("https://supabase.example/auth/v1/authorize");
    authorization.searchParams.set("provider", "google");
    authorization.searchParams.set("redirect_to", `${base}/signin.html?oauth_state=${body.state}`);
    authorization.searchParams.set("code_challenge", body.codeChallenge);
    authorization.searchParams.set("code_challenge_method", "s256");
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ authorizationUrl: authorization.toString() })
    });
  });
  await page.route("https://supabase.example/**", async route => {
    const authorization = new URL(route.request().url());
    const callback = new URL(authorization.searchParams.get("redirect_to"));
    callback.searchParams.set("code", "test-authorization-code");
    const target = JSON.stringify(callback.toString()).replace(/</g, "\\u003c");
    await route.fulfill({
      status: 200, contentType: "text/html",
      body: `<!doctype html><script>location.replace(${target})</script>`
    });
  });
  await page.route("**/api/auth?action=google-exchange", async route => {
    exchangeBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        user: { id: "2f6d2cc1-dc56-4d38-8e2c-2ca8528cd112", email: "guest@example.test" },
        role: "client"
      })
    });
  });
  await page.route("**/wedding.html**", route =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Wedding editor</title>" }));
  try {
    await page.goto(`${base}/signin.html?next=${encodeURIComponent("/wedding.html?slug=demo")}`);
    await page.waitForFunction(() => document.getElementById("google-signin")?.disabled === false);
    await page.click("#google-signin");
    await page.waitForURL("**/wedding.html?slug=demo");
    const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("ws-session") || "{}"));
    assert.equal(session.role, "client");
    assert.equal(session.a, "test-access-token");
    assert.match(exchangeBody.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(exchangeBody.code, "test-authorization-code");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-google-pkce")), null);
  } finally {
    await page.close();
  }
});

test("Google OAuth denial, missing state/code and exchange failures are visible", { skip }, async t => {
  if (!browser) {
    if (process.env.CI) throw new Error(skip);
    t.skip(skip);
    return;
  }
  const page = await browser.newPage();
  let exchanges = 0;
  await page.route("**/api/auth?action=google-status", route =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) }));
  await page.route("**/api/auth?action=google-exchange", async route => {
    exchanges += 1;
    await route.fulfill({
      status: 401, contentType: "application/json",
      body: JSON.stringify({ error: "Google sign-in could not be completed. Start again or use email sign-in." })
    });
  });
  try {
    await page.goto(`${base}/signin.html?code=auth-code&oauth_state=not-a-valid-state`);
    await page.getByText("Google sign-in could not be verified.", { exact: false }).waitFor();
    assert.equal(exchanges, 0);

    await page.goto(`${base}/signin.html?oauth_state=${"s".repeat(43)}`);
    await page.getByText("Google sign-in could not be verified.", { exact: false }).waitFor();
    assert.equal(exchanges, 0);

    await page.goto(`${base}/signin.html?code=auth-code`);
    await page.getByText("Google sign-in could not be verified.", { exact: false }).waitFor();
    assert.equal(exchanges, 0);

    await page.goto(`${base}/signin.html?error=access_denied&error_description=cancelled`);
    await page.getByText("Google sign-in was cancelled or denied.", { exact: false }).waitFor();
    assert.equal(exchanges, 0);

    const state = "r".repeat(43);
    await page.evaluate(stateValue => {
      sessionStorage.setItem("ws-google-pkce", JSON.stringify({
        state: stateValue, verifier: "v".repeat(43),
        returnTo: "/dashboard.html", createdAt: Date.now()
      }));
    }, state);
    await page.goto(`${base}/signin.html?code=auth-code&oauth_state=${state}`);
    await page.getByText("Google sign-in could not be completed.", { exact: false }).waitFor();
    assert.equal(exchanges, 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-session")), null);
  } finally {
    await page.close();
  }
});

test.after(() => new Promise(resolve => server.close(resolve)));
if (browser) test.after(async () => browser.close());
