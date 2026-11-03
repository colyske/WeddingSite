import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "");
const server = http.createServer(async (req, res) => {
  try {
    if (new URL(req.url, "http://localhost").pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end('<!doctype html><meta charset="utf-8"><script src="/fx.js" data-platform-default-currency></script>');
      return;
    }
    if (req.url === "/fx.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(await readFile(join(root, "fx.js")));
      return;
    }
  } catch {}
  res.writeHead(404).end("Not found");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
for (const options of [{ channel: "msedge" }, {}]) {
  try { browser = await chromium.launch(options); break; } catch { /* try next */ }
}
const skip = browser ? false : "No Chromium/Edge available (run: npx playwright install chromium)";
if (!browser && process.env.CI) throw new Error(skip);

test("public indicative USD quotes use a supported default only with fresh daily FX", { skip }, async () => {
  for (const state of ["fresh", "stale", "future"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/guest?action=platform-currency", route => route.fulfill({
      contentType: "application/json", body: JSON.stringify({ currency: "KES" })
    }));
    await page.route("https://open.er-api.com/v6/latest/USD", route => {
      const offset = state === "stale" ? -48 * 3600000 : state === "future" ? 6 * 60000 : 0;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        result: "success", base_code: "USD", rates: { USD: 1, KES: 130 },
        time_last_update_utc: new Date(Date.now() + offset).toUTCString()
      }) });
    });
    await page.goto(base);
    await page.waitForFunction(expected => window.WeddingSiteFX?.currency() === "KES" &&
      window.WeddingSiteFX.statusText().includes(expected), state === "fresh" ? "Latest published rate" : "STALE FX");
    const quote = await page.evaluate(() => window.WeddingSiteFX.formatPrimaryUsd(25, "KES"));
    if (state === "fresh") {
      assert.match(quote, /KES/);
      assert.ok(quote.includes("≈"), quote);
      assert.match(quote, /\$25\.00/);
    } else {
      assert.match(quote, /USD/);
      assert.match(quote, /equivalent unavailable/);
      assert.ok(!quote.includes("≈"), quote);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test.after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});
