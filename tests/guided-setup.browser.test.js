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
        if (action === "campaigns") data = { currency: "KES", campaigns: [
          { id: "paused-campaign", name: "Hidden campaign", goal_minor: 1000, enabled: false }
        ], summary: [], rows: [] };
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
    async function openSection(page, index) {
      if (await page.evaluate(() => matchMedia("(max-width: 600px)").matches) &&
          !(await page.locator(".guide-jump").evaluate(el => el.open))) {
        await page.locator(".guide-jump > summary").click();
      }
      const button = page.locator(".guide-nav button").nth(index);
      const navSize = await button.evaluate(el => el.getBoundingClientRect().height);
      await button.click();
      return navSize;
    }
    const first = await device();
    const page = first.page;
    await page.goto(`${base}/dashboard.html`);
    await page.locator("#guide-heading-couple").waitFor();
    assert.equal(await page.locator("[data-guide-step=guests] #currency").count(), 0, "currency is not classified as a guest RSVP setting");
    assert.equal(await page.locator("[data-guide-step=money] #currency").count(), 1);
    assert.equal(await page.locator("[data-guide-step]:visible").count(), 1);
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.locator(".guide-jump").evaluate(el => el.open), false);
    const firstQuestionTop = await page.locator("#guide-heading-couple").evaluate(el => el.getBoundingClientRect().top);
    assert.ok(firstQuestionTop < 700, `first question remains near the top on mobile (top: ${firstQuestionTop}px)`);
    await page.locator(".guide-jump > summary").click();
    assert.ok(await page.locator(".guide-nav button").first().isVisible(), "jump-to-section disclosure reveals accessible section links");
    const statusContrast = await page.locator(".guide-nav button small").first().evaluate(status => {
      const foreground = getComputedStyle(status).color.match(/\d+/g).slice(0, 3).map(Number);
      const background = getComputedStyle(status.parentElement).backgroundColor.match(/\d+/g).slice(0, 3).map(Number);
      const luminance = rgb => rgb.map(value => value / 255).map(value =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    });
    assert.ok(statusContrast >= 4.5, `section status has readable contrast (${statusContrast})`);
    await page.locator(".guide-jump > summary").click();
    await page.fill("#couple-names", "Amina & Joseph");
    await page.click("[data-guide-skip]");
    assert.match(page.url(), /#step=date$/);
    assert.equal(await page.locator("#guide-heading-date").evaluate(el => el === document.activeElement), true);
    assert.match(await page.locator("[data-guide-announcement]").innerText(), /Step 2 of 7/);
    await page.click("[data-guide-keep]");
    await page.reload();
    assert.equal(await page.locator("#couple-names").inputValue(), "Amina & Joseph");
    assert.equal(await page.locator("[data-guide-step=date]").isVisible(), true);
    assert.equal(await page.locator("#wedding-date").inputValue(), "", "no date is fabricated");
    await page.click("[data-guide-back]");
    assert.equal(await page.locator("#couple-names").inputValue(), "Amina & Joseph");
    await page.goBack();
    assert.equal(await page.locator("[data-guide-step=date]").isVisible(), true, "browser Back restores the hash-selected step");
    await page.goForward();
    await openSection(page, 3);
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
    assert.equal(await resume.locator("[data-guide-step=guests] #currency").count(), 0, "editor currency is grouped with money, not RSVPs");
    assert.equal(await resume.locator("[data-guide-step=money] #currency").count(), 1);
    assert.equal(await resume.locator("#welcome-story").inputValue(), "We are making plans together.", "another device resumes server-saved answers");
    assert.equal(await resume.evaluate(() => sessionStorage.getItem("ws-create-answers")), null);
    await resume.click("#publish-btn");
    assert.match(await resume.locator(".guide-errors").innerText(), /Before publishing/);
    assert.equal(calls.filter(call => call.action === "publish").length, 0);
    await resume.locator(".guide-errors a").filter({ hasText: "Date" }).first().click();
    assert.equal(await resume.locator("#wedding-date").evaluate(el => el === document.activeElement), true);
    await resume.fill("#wedding-date", "2027-06-12");
    await resume.fill("#location", "Nairobi");
    await openSection(resume, 5);
    await resume.click("#add-venue-btn");
    await resume.locator(".venue-name").fill("Garden ceremony");
    await resume.locator('#edit-form button[type="submit"]').click();
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Changes saved.");
    assert.equal(wedding.venues[0].name, "Garden ceremony");
    assert.equal(wedding.venues[0].event_time, null, "partial venue is preserved rather than dropped");
    await resume.click("#add-pre-event");
    assert.equal(await resume.locator("#pre-events-list .venue-item").count(), 1, "pre-wedding activities have a separate setup group");
    await resume.locator("#pre-events-list .venue-kind").selectOption("main");
    assert.equal(await resume.locator("#wedding-day-events-list .venue-item").count(), 2, "changing an event type moves it to the matching group");
    await resume.reload();
    await resume.locator("#guide-heading-venues").waitFor();
    assert.equal(await resume.locator(".venue-name").inputValue(), "Garden ceremony");
    await resume.locator(".venue-time").fill("10:00");
    await resume.locator(".venue-addr").fill("Garden Road");
    await resume.locator(".venue-date").fill("2027-06-12");
    await openSection(resume, 3);
    await resume.selectOption("#currency", "KES");
    await openSection(resume, 7);
    assert.equal(await resume.locator("#preset-song").isVisible(), true, "song bid amount suggestions are in the fundraising step");
    assert.equal(await resume.locator("summary").filter({ hasText: "Gift registry & suggested guest amounts" })
      .evaluate(el => el.closest("details").open), true, "fundraising setup opens with its feature controls visible");
    await resume.check("#preset-reset");
    await resume.check("#preset-reviewed");
    await resume.locator('#edit-form button[type="submit"]').click();
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Changes saved.");
    const currencySave = calls.filter(call => call.action === "update").at(-1).body;
    assert.equal(currencySave.currency, "KES");
    assert.equal(currencySave.amountPresets, null);
    assert.equal(currencySave.amountPresetsReviewed, true);
    await openSection(resume, 6);
    await resume.click("#edit-colors-btn");
    await resume.locator(".remove-color-btn").evaluateAll(buttons => buttons.forEach(button => button.click()));
    await resume.click("#apply-colors-btn");
    await resume.locator('#edit-form button[type="submit"]').click();
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Changes saved.");
    assert.deepEqual(wedding.palette, [], "an optional palette can be removed and saved");
    await openSection(resume, 9);
    for (const width of [320, 375, 414, 768, 1280]) {
      await resume.setViewportSize({ width, height: 900 });
      for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const navSize = await openSection(resume, index);
        assert.ok(await resume.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `step ${index} fits ${width}`);
        assert.ok(navSize >= 44, `step ${index} has a comfortable touch target at ${width}`);
      }
    }
    assert.equal(await resume.locator("#campaign-list .campaign-card").count(), 1, "hidden campaigns remain available to manage");
    assert.equal(await resume.locator("#campaign-list .cp-enabled").isChecked(), false);
    await resume.click("#add-campaign");
    assert.equal(await resume.locator("#campaign-list .campaign-card").last().locator(".cp-enabled").isChecked(), true,
      "new fundraising campaigns start visible to guests");
    assert.match(await resume.locator("#team-setup-link").getAttribute("href"), /team\.html\?weddingId=/);
    await resume.goto(`${base}/wedding.html?id=${id}#kyc-section`);
    await resume.locator("[data-guide-all]").waitFor();
    assert.equal(await resume.locator("#kyc-section").isVisible(), true);
    assert.equal(await resume.locator("#guide-heading-kyc").count(), 1, "private identity details are a guided setup step");
    await resume.fill("#kyc-p1", "Synthetic QA Partner");
    assert.match(await resume.locator("[data-guide-state]").innerText(), /private identity details are unsaved/i);
    await openSection(resume, 5);
    await openSection(resume, 4);
    assert.equal(await resume.locator("#kyc-p1").inputValue(), "Synthetic QA Partner", "KYC remains on the page while moving between setup steps");
    assert.match(await resume.locator("[data-guide-state]").innerText(), /private identity details are unsaved/i);
    await openSection(resume, 9);
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
