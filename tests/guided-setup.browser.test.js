import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("guided drafts: skip, tab resume, one create, server resume on another device, validation, save and accessible section navigation", async () => {
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
    const base = `http://127.0.0.1:${server.address().port}`;
    const id = "550e8400-e29b-41d4-a716-446655440000";
    let wedding;
    const calls = [], errors = [];
    async function device() {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => sessionStorage.setItem("ws-session", JSON.stringify({ a: "test-token", r: "client" })));
      await page.route("https://**", route => route.fulfill({ body: "" }));
      await page.route("**/api/**", route => {
        const action = new URL(route.request().url()).searchParams.get("action");
        const body = route.request().postData() ? route.request().postDataJSON() : null;
        calls.push({ action, body });
        let data = {};
        if (action === "list") data = { weddings: wedding ? [wedding] : [] };
        if (action === "create") {
          assert.ok(body.requestKey);
          assert.equal(wedding, undefined, "a single wedding must be created");
          wedding = { id, slug: "amina-and-joseph", couple_names: body.coupleNames,
            wedding_date: body.weddingDate, public_location: body.location || null, currency: body.currency,
            max_guest_capacity: body.maxCapacity, time_zone: body.timeZone, palette: body.palette,
            palette_names: [], venues: [], registry: [], tiers: [], published_at: null };
          data = { weddingId: id, slug: wedding.slug };
        }
        if (action === "get") data = { wedding, amountPresetMaxMinor: 100000000 };
        if (action === "quote") data = { quote: wedding?.wedding_date
          ? { fee_minor: 0, currency: wedding.currency, reason: "Fixture allowance." }
          : { fee_minor: null, pending_date: true, reason: "Set the wedding date to calculate the publication fee." } };
        if (action === "update") {
          wedding = { ...wedding, couple_names: body.coupleNames, slug: body.slug, welcome_story: body.welcomeStory,
            wedding_date: body.weddingDate || null, public_location: body.location || null, time_zone: body.timeZone,
            currency: body.currency, max_guest_capacity: body.maxCapacity, palette: body.palette,
            palette_names: body.paletteNames, attire_notes: body.attireNotes,
            venues: body.venues.map((venue, index) => ({ id: venue.id || `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
              name: venue.name, event_date: venue.eventDate, event_time: venue.eventTime, address: venue.address,
              kind: venue.kind, map_link: venue.mapLink, description: venue.description, is_main: venue.isMain })) };
          if ("amountPresets" in body) wedding.amount_presets = body.amountPresets;
          data = { wedding };
        }
        if (action === "publish") {
          assert.ok(wedding.wedding_date && wedding.public_location && wedding.venues.length, "incomplete draft never publishes");
          wedding.published_at = "2026-11-01T12:00:00Z";
          data = { wedding, published: true };
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
      });
      return { context, page };
    }
    const first = await device();
    const page = first.page;
    await page.goto(`${base}/dashboard.html`);
    await page.locator("#guide-heading-couple").waitFor();
    assert.equal(await page.locator("[data-guide-step]:visible").count(), 1);
    await page.fill("#couple-names", "Amina & Joseph");
    await page.click("[data-guide-skip]");
    assert.match(page.url(), /#step=venues$/);
    assert.equal(await page.locator("#guide-heading-venues").evaluate(el => el === document.activeElement), true);
    assert.match(await page.locator("[data-guide-announcement]").innerText(), /Step 2 of 5/);
    await page.click("[data-guide-keep]");
    await page.reload();
    assert.equal(await page.locator("#couple-names").inputValue(), "Amina & Joseph");
    assert.equal(await page.locator("[data-guide-step=venues]").isVisible(), true);
    assert.equal(await page.locator("#wedding-date").inputValue(), "", "no date is fabricated");
    await page.click("[data-guide-back]");
    assert.equal(await page.locator("#couple-names").inputValue(), "Amina & Joseph");
    await page.goBack();
    assert.equal(await page.locator("[data-guide-step=venues]").isVisible(), true, "browser Back restores the hash-selected step");
    await page.goForward();
    await page.locator(".guide-nav button").nth(3).click();
    await page.click("[data-guide-skip]");
    assert.match(await page.locator("[data-guide-review]").innerText(), /Needs answers/);
    await page.click("#create-submit");
    await page.waitForURL(`**/wedding.html?id=${id}&slug=amina-and-joseph#step=couple`);
    await page.locator("#guide-heading-couple").waitFor();
    assert.equal(calls.filter(call => call.action === "create").length, 1);
    assert.equal(calls.find(call => call.action === "create").body.weddingDate, null);
    assert.equal(calls.find(call => call.action === "create").body.venues.length, 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-create-answers")), null);
    assert.match(await page.locator("[data-guide-state]").innerText(), /Saved wedding details/);
    assert.match(await page.locator("#fee-box").innerText(), /Set the wedding date/);
    await page.fill("#welcome-story", "We are making plans together.");
    await page.click("[data-guide-skip]");
    await page.locator('#edit-form button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById("notice").textContent === "Changes saved.");
    assert.equal(wedding.welcome_story, "We are making plans together.");
    assert.equal(wedding.wedding_date, null);
    assert.match(await page.locator("[data-guide-state]").innerText(), /Saved wedding details/);

    const second = await device();
    const resume = second.page;
    await resume.goto(`${base}/wedding.html?id=${id}#step=venues`);
    await resume.locator("#guide-heading-venues").waitFor();
    assert.equal(await resume.locator("#welcome-story").inputValue(), "We are making plans together.", "another device resumes server-saved answers");
    assert.equal(await resume.evaluate(() => sessionStorage.getItem("ws-create-answers")), null);
    await resume.click("#publish-btn");
    assert.match(await resume.locator(".guide-errors").innerText(), /Before publishing/);
    assert.equal(calls.filter(call => call.action === "publish").length, 0);
    await resume.locator(".guide-errors a").filter({ hasText: "Date" }).first().click();
    assert.equal(await resume.locator("#wedding-date").evaluate(el => el === document.activeElement), true);
    await resume.fill("#wedding-date", "2027-06-12");
    await resume.fill("#location", "Nairobi");
    await resume.locator('.guide-nav button').nth(3).click();
    await resume.click("#add-venue-btn");
    await resume.locator(".venue-name").fill("Garden ceremony");
    await resume.locator('#edit-form button[type="submit"]').click();
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Changes saved.");
    assert.equal(wedding.venues[0].name, "Garden ceremony");
    assert.equal(wedding.venues[0].event_time, null, "partial venue is preserved rather than dropped");
    await resume.reload();
    await resume.locator("#guide-heading-venues").waitFor();
    assert.equal(await resume.locator(".venue-name").inputValue(), "Garden ceremony");
    await resume.locator(".venue-time").fill("10:00");
    await resume.locator(".venue-addr").fill("Garden Road");
    await resume.locator(".venue-date").fill("2027-06-12");
    await resume.locator('.guide-nav button').nth(2).click();
    await resume.selectOption("#currency", "KES");
    await resume.locator("summary").filter({ hasText: "Optional suggested giving" }).click();
    await resume.check("#preset-reset");
    await resume.check("#preset-reviewed");
    await resume.locator('#edit-form button[type="submit"]').click();
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Changes saved.");
    const currencySave = calls.filter(call => call.action === "update").at(-1).body;
    assert.equal(currencySave.currency, "KES");
    assert.equal(currencySave.amountPresets, null);
    assert.equal(currencySave.amountPresetsReviewed, true);
    await resume.locator('.guide-nav button').nth(4).click();
    await resume.click("#edit-colors-btn");
    await resume.locator(".remove-color-btn").evaluateAll(buttons => buttons.forEach(button => button.click()));
    await resume.click("#apply-colors-btn");
    await resume.locator('#edit-form button[type="submit"]').click();
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Changes saved.");
    assert.deepEqual(wedding.palette, [], "an optional palette can be removed and saved");
    await resume.locator('.guide-nav button').last().click();
    for (const width of [320, 375, 768, 1280]) {
      await resume.setViewportSize({ width, height: 900 });
      for (const index of [0, 1, 2, 3, 4, 5, 6]) {
        await resume.locator(".guide-nav button").nth(index).click();
        assert.ok(await resume.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `step ${index} fits ${width}`);
      }
    }
    await resume.goto(`${base}/wedding.html?id=${id}#kyc-section`);
    await resume.locator("[data-guide-all]").waitFor();
    assert.equal(await resume.locator("#kyc-section").isVisible(), true);
    await resume.locator('.guide-nav button').last().click();
    await resume.click("#publish-btn");
    await resume.click("#confirm-publish");
    await resume.locator("#published-section").waitFor({ state: "visible" });
    assert.equal(calls.filter(call => call.action === "publish").length, 1);
    assert.deepEqual(errors, []);
    await first.context.close();
    await second.context.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
