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
      const body = await readFile(new URL(`..${path}`, import.meta.url));
      res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream" })
        .end(body);
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const base = `http://127.0.0.1:${server.address().port}`;
    const id = "550e8400-e29b-41d4-a716-446655440000";
    let wedding;
    let savedCampaigns = [{ id: "paused-campaign", name: "Hidden campaign", goal_minor: 1000, enabled: false }];
    let savedFaq = [], savedTravel = "";
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
        calls.push({ action, body, path: new URL(route.request().url()).pathname });
        let data = {};
        if (action === "collection-capabilities") data = { currencies: [
          { code: "USD", name: "US Dollar", methods: [{ name: "Card", markets: ["United States"] }] },
          { code: "KES", name: "Kenyan Shilling", methods: [{ name: "M-Pesa", markets: ["Kenya"] }] }
        ] };
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
        if (action === "invite") {
          assert.equal(route.request().method(), "POST");
          data = { inviteLink: "/team-invite.html?token=synthetic-token" };
        }
        if (action === "get") data = { wedding, amountPresetMaxMinor: 100000000 };
        if (action === "quote") data = { quote: wedding?.wedding_date
          ? { fee_minor: 0, currency: wedding.currency, reason: "Fixture allowance." }
          : { fee_minor: null, pending_date: true, reason: "Set the wedding date to calculate the publication fee." } };
        if (action === "campaigns") data = { currency: wedding?.currency || "USD", campaigns: savedCampaigns, summary: [], rows: [] };
        if (action === "campaigns-save") {
          savedCampaigns = body.campaigns.map((campaign, index) => ({
            id: campaign.id || `saved-campaign-${index}`, name: campaign.name, goal_minor: Number(campaign.goal) * 100,
            purpose: campaign.purpose, enabled: campaign.enabled,
            milestones: campaign.milestones.map((milestone, milestoneIndex) => ({
              id: milestone.id || `saved-milestone-${index}-${milestoneIndex}`, name: milestone.name,
              target_minor: Number(milestone.target) * 100, description: milestone.description
            }))
          }));
          data = { ok: true };
        }
        if (action === "extras-get") data = { faq: savedFaq, travel: savedTravel };
        if (action === "extras-save") {
          savedFaq = body.faq;
          savedTravel = body.travel;
          data = { ok: true };
        }
        if (action === "update") {
          wedding = { ...wedding, couple_names: body.coupleNames, slug: body.slug, welcome_story: body.welcomeStory,
            cover_image_url: body.coverImageUrl, guest_instructions: body.guestInstructions,
            wedding_date: body.weddingDate || null, public_location: body.location || null, time_zone: body.timeZone,
            currency: body.currency, max_guest_capacity: body.maxCapacity, palette: body.palette,
            palette_names: body.paletteNames, attire_notes: body.attireNotes,
            registry: body.registry.map((item, index) => ({
              id: item.id || `registry-item-${index}`, name: item.name, target_amount_minor: Number(item.targetAmount) * 100,
              description: item.description, category: item.category, notes: item.notes
            })),
            venues: body.venues.map((venue, index) => ({ id: venue.id || `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
              name: venue.name, event_date: venue.eventDate, event_time: venue.eventTime, address: venue.address,
              kind: venue.kind, map_link: venue.mapLink, description: venue.description, is_main: venue.isMain })) };
          if ("revenueFeatures" in body) wedding.revenue_features = body.revenueFeatures;
          data = { wedding };
        }
        if (action === "publish") {
          assert.ok(wedding.wedding_date && wedding.venues.length, "incomplete draft never publishes");
          wedding.published_at = "2026-11-01T12:00:00Z";
          data = { wedding, published: true };
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
      });
      return { context, page };
    }
    async function openSection(page, index) {
      if (await page.evaluate(() => matchMedia("(max-width: 600px)").matches))
        await page.locator(".guide-jump").evaluate(el => { el.open = true; });
      const button = page.locator(".guide-nav button").nth(index);
      await button.waitFor({ state: "visible" });
      const navSize = await button.evaluate(el => el.getBoundingClientRect().height);
      await button.click();
      return navSize;
    }
    const first = await device();
    const page = first.page;
    await page.goto(`${base}/dashboard.html`);
    await page.locator("#create-submit").waitFor();
    await page.fill("#couple-names", "Amina & Joseph");
    await page.setViewportSize({ width: 320, height: 900 });
    const createWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(createWidth <= 320, `draft creation fits the narrow mobile viewport (${createWidth}px)`);
    await page.click("#create-submit");
    await page.waitForURL(`**/wedding.html?id=${id}&slug=amina-and-joseph#step=couple`, { waitUntil: "domcontentloaded" });
    await page.locator("#guide-heading-couple").waitFor();
    assert.equal(calls.filter(call => call.action === "create").length, 1, "the guide handoff creates exactly one draft");
    assert.equal(calls.find(call => call.action === "create").body.coupleNames, "Amina & Joseph");
    assert.equal(calls.find(call => call.action === "create").body.weddingDate, null);
    assert.equal(calls.find(call => call.action === "create").body.venues.length, 0);
    assert.match(await page.locator("[data-guide-state]").innerText(), /Saved wedding details/);
    assert.match(await page.locator("#fee-box").innerText(), /Set the wedding date/);
    assert.equal(await page.locator("[data-guide-step]:not(#kyc-section):visible").count(), 1,
      "only the active wedding setup question is displayed");
    assert.equal(await page.locator("[data-guide-step=guests] #currency").count(), 0, "currency is not classified as a guest RSVP setting");
    assert.equal(await page.locator("[data-guide-step=money] #currency").count(), 1);
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
    await page.fill("#welcome-story", "We are making plans together.");
    await page.click("[data-guide-skip]");
    assert.match(page.url(), /#step=date$/);
    assert.equal(await page.locator("#guide-heading-date").evaluate(el => el === document.activeElement), true);
    assert.match(await page.locator("[data-guide-announcement]").innerText(), /Step 2 of 12/);
    await page.click("[data-guide-save]");
    await page.waitForFunction(() => document.getElementById("notice").textContent === "Your wedding details and setup answers are saved.");
    await page.reload();
    await page.locator("#guide-heading-date").waitFor({ state: "visible" });
    assert.equal(await page.locator("#couple-names").inputValue(), "Amina & Joseph");
    const coupleChip = page.locator(".guide-nav button").nth(0), dateChip = page.locator(".guide-nav button").nth(1);
    assert.equal(await coupleChip.getAttribute("data-state"), "complete", "answered sections are marked complete");
    assert.match(await coupleChip.locator("small").textContent(), /✓\s*Complete/, "state uses text and an icon as well as colour");
    assert.ok(["notstarted", "progress"].includes(await dateChip.getAttribute("data-state")));
    assert.match(await dateChip.locator("small").textContent(), /needs answers/i);
    assert.notEqual(await coupleChip.evaluate(el => getComputedStyle(el).backgroundColor),
      await dateChip.evaluate(el => getComputedStyle(el).backgroundColor), "complete and unanswered sections look different");
    const meter = page.locator(".guide-meter [role=progressbar]");
    assert.match(await meter.getAttribute("aria-valuetext"), /sections complete/);
    assert.equal(await meter.getAttribute("aria-valuemax"), "11", "progress counts the 11 setup sections, not the review page");
    assert.match(await page.locator("[data-guide-meter]").innerText(), /Step 2 of 12 · \d+ of 11 sections complete/);
    assert.equal(await page.locator("#cover-image-url").evaluate(el => el.required), false, "cover photo is optional");
    assert.equal(await page.locator("#guest-instructions").evaluate(el => el.required), false, "pre-RSVP guest instructions are optional");
    assert.equal(await page.locator("[data-guide-step=date]").isVisible(), true);
    assert.equal(await page.locator("#wedding-date").inputValue(), "", "no date is fabricated");
    await page.click("[data-guide-back]");
    assert.equal(await page.locator("#couple-names").inputValue(), "Amina & Joseph");
    await page.goBack();
    assert.equal(await page.locator("[data-guide-step=date]").isVisible(), true, "browser Back restores the hash-selected step");
    await page.goForward();
    await openSection(page, 2);
    await page.click("[data-guide-skip]");
    assert.match(page.url(), /#step=venues$/);
    await openSection(page, 10);
    assert.equal(await page.locator("[data-guide-step=publication] #status-badge").isVisible(), true,
      "status and publication controls live in their own setup step");
    assert.equal(await page.locator("[data-guide-step=publication] #pay-fee-btn").count(), 1);
    assert.equal(await page.locator("#wedding-workspace").evaluate(el => el.open), false,
      "operational workspace panels stay collapsed below the active step");
    await openSection(page, 0);
    assert.equal(await page.locator("#status-badge").isVisible(), false, "status panel does not repeat below every step");
    await openSection(page, 11);
    assert.match(await page.locator("[data-guide-review] .guide-review-item.is-notstarted").first().innerText(), /needs answers/i, "skipped required sections ask for answers");
    assert.ok(await page.locator("[data-guide-review] .guide-review-item.is-complete").count() >= 1, "review marks completed sections");
    assert.ok(await page.locator("[data-guide-review] .guide-review-item.is-notstarted, [data-guide-review] .guide-review-item.is-progress").count() >= 1,
      "review marks sections that still need answers");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ws-create-answers")), null);
    assert.equal(calls.filter(call => call.action === "create").length, 1);
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
    await openSection(resume, 3);
    await resume.click("#add-venue-btn");
    await resume.locator(".venue-name").fill("Garden ceremony");
    await resume.click("[data-guide-save]");
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Your wedding details and setup answers are saved.");
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
    await openSection(resume, 2);
    await resume.selectOption("#currency", "KES");
    assert.match(await resume.locator("#currency-change-help").innerText(), /will not convert.*numbers stay the same/i);
    await openSection(resume, 6);
    assert.equal(await resume.locator("#preset-song, #preset-gift, #preset-reset").count(), 0,
      "organizers no longer configure suggested contribution amounts");
    assert.equal(await resume.locator("#feature-giving").isVisible(), true, "fundraising feature controls are visible");
    assert.equal(await resume.getByText("Choose what guests can see").count(), 0, "the master feature panel is gone");
    assert.equal(await resume.locator(".registry-item").count(), 1, "a registry form is ready without clicking Add");
    assert.equal(await resume.locator(".registry-item .registry-name").isVisible(), true);
    assert.ok(await resume.locator(".tier-item").count() >= 1, "a sponsor package form is ready without clicking Add");
    assert.equal(await resume.locator(".tier-item .tier-name").first().isVisible(), true);
    await resume.click("#add-registry-btn");
    const registryItem = resume.locator(".registry-item").last();
    assert.equal(await registryItem.isVisible(), true, "registry inputs are visible in the active setup step");
    await registryItem.locator(".registry-name").fill("Wedding celebration");
    await registryItem.locator(".registry-target").fill("500");
    const featureToggles = ["#feature-giving", "#feature-sponsors", "#feature-featured-sponsors",
      "#feature-song-requests", "#feature-vip-seating"];
    for (const selector of featureToggles) {
      assert.equal(await resume.locator(selector).isChecked(), true, `${selector} is visible by default`);
    }
    assert.equal(await resume.locator("[data-feature-hint=feature-song-requests]").isVisible(), false);
    await resume.uncheck("#feature-song-requests");
    assert.equal(await resume.locator("[data-feature-hint=feature-song-requests]").isVisible(), true,
      "a hidden feature explains its effect in context");
    await resume.click("[data-guide-save]");
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Your wedding details and setup answers are saved.");
    const currencySave = calls.filter(call => call.action === "update").at(-1).body;
    assert.equal(currencySave.currency, "KES");
    assert.equal("amountPresets" in currencySave, false, "save does not submit suggested amounts");
    assert.equal(currencySave.registry.length, 1, "an untouched starter registry form is not saved");
    if ("tiers" in currencySave) assert.equal(currencySave.tiers.length, 0, "an untouched starter sponsor package is not saved");
    await openSection(resume, 7);
    assert.equal(await resume.locator("#campaign-list").isVisible(), true, "campaign setup is in the guide");
    await openSection(resume, 8);
    assert.equal(await resume.locator("#faq-add").isVisible(), true, "FAQ setup is in the guide");
    assert.equal(await resume.locator(".faq-row").count(), 1, "a FAQ form is ready without clicking Add");
    assert.equal(await resume.locator(".faq-row .faq-q").isVisible(), true);
    assert.equal(currencySave.revenueFeatures.song_requests, false, "an opt-out is included in the persisted save");
    assert.deepEqual(wedding.revenue_features, {
      giving: true, sponsors: true, featured_sponsors: true, song_requests: false, vip_seating: true
    });
    assert.equal(wedding.registry[0].name, "Wedding celebration", "a configured fundraising route is saved for publication readiness");
    await openSection(resume, 5);
    await resume.locator(".remove-color-btn").evaluateAll(buttons => buttons.forEach(button => button.click()));
    await resume.click("#apply-colors-btn");
    await resume.click("[data-guide-save]");
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Your wedding details and setup answers are saved.");
    assert.deepEqual(wedding.palette, [], "an optional palette can be removed and saved");
    await openSection(resume, 9);
    const updatesBeforeInvite = calls.filter(call => call.action === "update").length;
    assert.equal(await resume.locator("#helper-invite-email").isVisible(), true, "the helper invite form is visible by default");
    assert.equal(calls.filter(call => call.path === "/api/team").length, 0, "an empty helper form creates nothing");
    await resume.click("#helper-invite-create");
    assert.match(await resume.locator("#helper-invite-status").innerText(), /sign-in email/);
    assert.equal(calls.filter(call => call.path === "/api/team").length, 0, "an invalid invite is not submitted");
    await resume.fill("#helper-invite-email", "helper@example.test");
    await resume.selectOption("#helper-invite-role", { index: 1 });
    await resume.click("#helper-invite-create");
    await resume.locator("#helper-invite-result").waitFor({ state: "visible" });
    const invite = calls.filter(call => call.path === "/api/team");
    assert.equal(invite.length, 1);
    assert.equal(invite[0].body.weddingId, id);
    assert.equal(invite[0].body.email, "helper@example.test");
    assert.match(await resume.locator("#helper-invite-link").inputValue(), /\/team-invite\.html\?token=synthetic-token$/);
    assert.match(await resume.locator("#helper-invite-status").innerText(), /not sent/);
    assert.equal(calls.filter(call => call.action === "update").length, updatesBeforeInvite, "creating an invite does not save the wedding form");
    for (const width of [320, 375, 414, 768, 1280]) {
      await resume.setViewportSize({ width, height: 900 });
      for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
        const navSize = await openSection(resume, index);
        assert.ok(await resume.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `step ${index} fits ${width}`);
        assert.ok(navSize >= 44, `step ${index} has a comfortable touch target at ${width}`);
        const controls = await resume.locator(".guide-buttons button:visible").evaluateAll(buttons =>
          buttons.map(button => { const box = button.getBoundingClientRect(); return { left: box.left, right: box.right, height: box.height, text: button.textContent.trim() }; }));
        assert.ok(controls.length >= 3, `footer controls are present at ${width}`);
        for (const control of controls) {
          assert.ok(control.height >= 44, `${control.text} has a touch target at ${width}: ${control.height}`);
          assert.ok(control.left >= 0 && control.right <= width, `${control.text} fits at ${width}`);
        }
      }
    }
    assert.equal(await resume.locator("#campaign-list .campaign-card").count(), 1, "hidden campaigns remain available to manage");
    assert.equal(await resume.locator("#campaign-list .cp-enabled").isChecked(), false);
    await openSection(resume, 7);
    await resume.click("#add-campaign");
    const newCampaign = resume.locator("#campaign-list .campaign-card").last();
    assert.equal(await newCampaign.locator(".cp-enabled").isChecked(), true,
      "new fundraising campaigns start visible to guests");
    await newCampaign.locator(".cp-name").fill("Our home");
    await newCampaign.locator(".cp-goal").fill("1500");
    await resume.click("[data-guide-save]");
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Your wedding details and setup answers are saved.");
    assert.equal(await resume.locator("#campaign-list .campaign-card").count(), 2, "campaign answers save with the persistent guide control");
    await openSection(resume, 8);
    await resume.click("#faq-add");
    await resume.locator(".faq-row").last().locator(".faq-q").fill("When should guests arrive?");
    await resume.locator(".faq-row").last().locator(".faq-a").fill("Please arrive by 3 pm.");
    await resume.click("[data-guide-save]");
    await resume.waitForFunction(() => document.getElementById("notice").textContent === "Your wedding details and setup answers are saved.");
    await resume.reload();
    await openSection(resume, 7);
    assert.equal(await resume.locator("#campaign-list .campaign-card").count(), 2, "saved campaigns resume after reload");
    await openSection(resume, 8);
    assert.equal(await resume.locator(".faq-row .faq-q").last().inputValue(), "When should guests arrive?",
      "saved FAQs resume after reload");
    assert.match(await resume.locator("#team-setup-link").getAttribute("href"), /team\.html\?weddingId=/);
    await resume.goto(`${base}/wedding.html?id=${id}#kyc-section`);
    await resume.locator("#kyc-section").waitFor({ state: "visible" });
    assert.equal(await resume.locator("#kyc-section").isVisible(), true);
    assert.equal(await resume.locator("#guide-heading-kyc").count(), 0, "private identity details stay separate from wedding completion");
    assert.equal(await resume.locator("#wedding-workspace").evaluate(el => el.open), true, "the KYC deep link opens the workspace");
    await resume.fill("#kyc-p1", "Synthetic QA Partner");
    await openSection(resume, 0);
    await openSection(resume, 5);
    await openSection(resume, 4);
    assert.equal(await resume.locator("#kyc-p1").inputValue(), "Synthetic QA Partner", "KYC remains on the page while moving between setup steps");
    await openSection(resume, 11);
    await resume.click("#publish-btn");
    await resume.click("#confirm-publish");
    await resume.locator("#published-section").waitFor({ state: "visible" });
    assert.equal(calls.filter(call => call.action === "publish").length, 1);
    assert.ok(!wedding.cover_image_url && !wedding.guest_instructions, "publishing does not require a cover photo or guest instructions");
    for (const call of calls.filter(call => call.action === "campaigns-save"))
      assert.ok(call.body.campaigns.every(campaign => campaign.name.trim()), "blank starter campaigns are never saved");
    for (const call of calls.filter(call => call.action === "extras-save"))
      assert.ok(call.body.faq.every(row => Object.values(row).some(value => String(value ?? "").trim())), "blank FAQ forms are never saved");
    assert.deepEqual(errors, []);
    await first.context.close();
    await second.context.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
