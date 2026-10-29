import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("KES and USD saved arrays drive new/existing songs, registry, campaigns and milestone dialogs without pricing fixed offers", async () => {
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
    for (const currency of ["KES", "USD"]) {
      const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
      await page.route("https://**", route => route.fulfill({ body: "" }));
      await page.route("https://open.er-api.com/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        result: "success", base_code: "USD", time_last_update_utc: new Date().toUTCString(), rates: { USD: 1, KES: 125 }
      }) }));
      const amounts = currency === "KES"
        ? { currency, song: [10000, 50000, 100000], gift: [50000, 100000, 500000] }
        : { currency, song: [725, 1250], gift: [1500, 3000] };
      const wedding = { id: "550e8400-e29b-41d4-a716-446655440000", slug: "qa-couple", couple_names: "QA Couple",
        wedding_date: "2099-01-01", currency, amount_presets: amounts, palette: ["#244b3a"],
        registry: [{ id: "registry-item", name: "Home fund", target_amount_minor: 9000000 }] };
      await page.route("**/api/guest**", route => {
        const action = new URL(route.request().url()).searchParams.get("action");
        const body = action === "site" ? { wedding } : action === "leaderboard" ? { bids: [
          { song_title: "Sample Song", artist_name: "Sample Artist", bid_amount_minor: 10000, bid_count: 1 }
        ] } : action === "fundraising" ? {
          campaigns: [{ id: "celebration", name: "Celebration fund", goal_minor: 9000000, raised_minor: 0,
            milestones: [{ id: "milestone", name: "Garden", target_minor: 500000 }] }],
          tiers: [{ id: "fixed-tier", name: "Fixed package", min_amount_minor: 76500, perks: "Package" }],
          vip: { id: "fixed-seat", title: "Fixed seat", price_minor: 65400, seats_total: 20, seats_sold: 0 }
        } : {};
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      });
      await page.route("**/api/checkout**", route => {
        assert.equal(new URL(route.request().url()).searchParams.get("action"), "options", "never initiate payment");
        return route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"Fixture checkout unavailable"}' });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/guest.html?slug=qa-couple`);
      await page.locator("#leaderboard-body summary").click();
      const songValues = () => page.locator("[data-song-bid]").evaluateAll(buttons => buttons.map(button => Number(button.dataset.amount)));
      assert.deepEqual(await songValues(), [...amounts.song, 0]);
      assert.deepEqual(await page.locator("[data-new-song-amount]").evaluateAll(buttons => buttons.map(b => Number(b.dataset.newSongAmount))), [...amounts.song, 0]);
      await page.locator("[data-new-song-amount]").first().click();
      assert.equal(await page.locator("#song-request-amount").inputValue(), String(amounts.song[0] / 100));
      await page.locator("[data-song-bid]").first().click();
      assert.equal(await page.locator("#pay-amount").inputValue(), String(amounts.song[0] / 100));
      assert.deepEqual(await page.locator("[data-pay-preset]").evaluateAll(buttons => buttons.map(b => Number(b.dataset.payPreset))), [...amounts.song, 0]);
      await page.locator("[data-pay-preset='0']").click();
      assert.equal(await page.locator("#pay-amount").inputValue(), "");
      await page.locator("#pay-cancel").click();
      for (const kind of ["registry", "fund"]) {
        const buttons = page.locator(`[data-buy="${kind}"][data-preset][data-min]`);
        await buttons.first().waitFor();
        assert.deepEqual(await buttons.evaluateAll(items => items.map(b => Number(b.dataset.min))), amounts.gift);
        await buttons.first().click();
        assert.equal(await page.locator("#pay-amount").inputValue(), String(amounts.gift[0] / 100));
        assert.equal(await page.locator("#pay-amount").getAttribute("readonly"), null);
        await page.locator("#pay-cancel").click();
      }
      await page.locator("[data-milestone]").click();
      assert.deepEqual(await page.locator("[data-pay-preset]").evaluateAll(buttons => buttons.map(b => Number(b.dataset.payPreset))), [...amounts.gift, 0]);
      await page.locator("#pay-cancel").click();
      await page.locator('[data-buy="vip"]').click();
      assert.equal(await page.locator("#pay-amount").inputValue(), "654");
      assert.equal(await page.locator("[data-pay-preset]").count(), 0);
      assert.notEqual(await page.locator("#pay-amount").getAttribute("readonly"), null);
      await page.locator("#pay-cancel").click();
      if (currency === "KES") {
        await page.waitForFunction(() => document.querySelector("[data-preset-money]").textContent.includes("approx. USD"));
        assert.match(await page.locator("#song-request-presets").innerText(), /KES 100\.00 \[approx\. USD 0\.80/i);
        await page.evaluate(() => {
          localStorage.setItem("weddingsite-demo-fx-rates", JSON.stringify({
            base: "USD", rates: { USD: 1, KES: 125 }, rateDate: new Date(Date.now() - 37 * 3600000).toUTCString()
          }));
          window.dispatchEvent(new StorageEvent("storage", { key: "weddingsite-demo-fx-rates" }));
        });
        assert.match(await page.locator("#song-request-presets").innerText(), /USD equivalent unavailable/i);
        assert.deepEqual(await songValues(), [...amounts.song, 0], "FX display cannot reprice presets");
      } else {
        assert.doesNotMatch(await page.locator("#song-request-presets").innerText(), /approx/);
        assert.match(await page.locator("#song-request-presets").innerText(), /USD 7\.25/i);
      }
      await page.close();
    }

    const page = await browser.newPage();
    await page.route("https://**", route => route.fulfill({ body: "" }));
    const editorMarkup = await readFile(new URL("../wedding.html", import.meta.url), "utf8");
    const fieldset = editorMarkup.match(/<fieldset>\s*<legend>Suggested guest amounts[\s\S]*?<\/fieldset>/)[0];
    await page.route("**/preset-editor", route => route.fulfill({ contentType: "text/html", body: `
      <select id="currency" data-wedding-currency><option>USD</option><option>KES</option><option>EUR</option></select>
      ${fieldset}<script src="/currencies.js"></script><script src="/amount-presets.js"></script>
      <script src="/amount-presets-editor.js"></script><script>window.editor=WSAmountPresetEditor();</script>` }));
    await page.goto(`http://127.0.0.1:${server.address().port}/preset-editor`);
    await page.evaluate(() => {
      document.getElementById("currency").value = "KES";
      editor.load({ currency: "KES", amount_presets: { currency: "KES", song: [12000, 45000], gift: [32000] } }, 500000);
    });
    assert.equal(await page.locator("#preset-song").inputValue(), "120, 450");
    assert.deepEqual(await page.evaluate(() => editor.payload()), {}, "unrelated saves keep chosen presets");
    await page.selectOption("#currency", "USD");
    assert.equal(await page.locator("#preset-song").inputValue(), "", "currency change never reinterprets old amounts");
    assert.equal(await page.evaluate(() => { try { editor.payload(); return false; } catch { return true; } }), true);
    await page.click("#preset-suggest");
    assert.equal(await page.locator("#preset-song").inputValue(), "5, 10, 25, 50");
    await page.check("#preset-reviewed");
    const result = await page.evaluate(() => editor.payload());
    assert.deepEqual(result, { amountPresets: { currency: "USD", song: [500, 1000, 2500, 5000], gift: [1000, 2500, 5000] },
      amountPresetsReviewed: true, amountPresetsBaseCurrency: "KES",
      amountPresetsBase: { currency: "KES", song: [12000, 45000], gift: [32000] } });
    for (const invalid of ["0", "1.001", "Infinity", "5000.01", "1,2,3,4,5,6,7"]) {
      await page.fill("#preset-song", invalid);
      await page.check("#preset-reviewed");
      assert.equal(await page.evaluate(() => { try { editor.payload(); return false; } catch { return true; } }), true, invalid);
    }
    await page.selectOption("#currency", "KES");
    await page.click("#preset-suggest");
    await page.check("#preset-reviewed");
    assert.deepEqual((await page.evaluate(() => editor.payload())).amountPresets.song, [10000, 50000, 100000]);
    await page.uncheck("#preset-reviewed");
    await page.check("#preset-reset");
    await page.check("#preset-reviewed");
    assert.deepEqual(await page.evaluate(() => editor.payload()), {
      amountPresets: null, amountPresetsReviewed: true, amountPresetsBaseCurrency: "KES",
      amountPresetsBase: { currency: "KES", song: [12000, 45000], gift: [32000] }
    });
    await page.evaluate(() => editor.saved({ currency: "KES" }));
    assert.deepEqual(await page.evaluate(() => editor.payload()), {});
    await page.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
