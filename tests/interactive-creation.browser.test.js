import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";
import { interactivePreview } from "../server/interactive-preview.js";
import { interactiveStarter } from "../server/interactive-starter.js";
import { publicWeddingStyle } from "../server/wedding-style.js";
import "../currencies.js";

const id = "550e8400-e29b-41d4-a716-446655440001";
test("interactive desktop/mobile renderer edits, saves, isolates guest activity and protects dialogs", { timeout: 360000 }, async () => {
  const style = await publicWeddingStyle("showcase-wedding");
  const seed = interactiveStarter(globalThis.WSStarterSetup.normalize({ ...style.setup, reviewed: true }, "KES"));
  const structure = globalThis.WSStarterSetup.structure(seed.setup);
  structure.campaigns = [];
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.includes("..")) throw new Error("Invalid path");
      res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "application/octet-stream");
      res.end(await readFile(new URL(`..${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      let wedding = {
        id, slug: viewport.width > 600 ? "internal-draft" : "amina-and-david",
        couple_names: viewport.width > 600 ? "" : "Amina & David", currency: "KES",
        wedding_date: null, welcome_story: seed.story, cover_image_url: "https://images.example.test/our-cover.jpg",
        palette: ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"],
        palette_names: [], time_zone: "Africa/Nairobi",
        venues: seed.venues.map((item, index) => ({ id: `${id.slice(0, -1)}${index + 2}`, name: item.name, kind: item.kind,
          is_main: item.isMain, event_time: item.eventTime, event_date: null, address: item.address, description: item.description })),
        registry: [], tiers: [], faq: seed.setup.content.faq, travel_info: seed.setup.content.travel, attire_notes: seed.setup.content.attire,
        page_content: {}, creation_content_reviewed: false,
        interactive_creation: true, starter_structure: structuredClone(structure), published_at: null
      };
      const campaigns = [{ id, name: seed.setup.campaigns[0].name, purpose: seed.setup.campaigns[0].purpose,
        goal_minor: 50000000, currency: "KES", enabled: true, milestones: seed.setup.campaigns[0].milestones.map(item => ({
          name: item.name, target_minor: item.targetMinor, description: item.description, reached: false
        })) }];
      const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
      const page = await context.newPage(), errors = [], guestCalls = [];
      page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") console.error("Browser:", message.text()); });
      await page.addInitScript(() => {
        sessionStorage.setItem("ws-session", JSON.stringify({ a: "fixture-token", r: "client" }));
        Object.defineProperty(window, "WSGuestFetch", {
          configurable: true,
          set(fetch) {
            Object.defineProperty(window, "WSGuestFetch", {
              configurable: true, writable: true,
              value: async (input, options) => {
                if (new URL(input, location.href).searchParams.get("action") === "extras") {
                  await new Promise(done => setTimeout(done, 1500));
                }
                return fetch(input, options);
              }
            });
          }
        });
        document.addEventListener("ws:preview-ready", () => { window.mainPreviewReady = true; });
        document.addEventListener("ws:extras-ready", () => { window.extrasArrivedLate = window.mainPreviewReady === true; });
      });
      await page.route("https://**", route => route.fulfill({ body: "" }));
      await page.route("**/api/**", async route => {
        const url = new URL(route.request().url()), action = url.searchParams.get("action");
        if (url.pathname !== "/api/weddings") guestCalls.push(url.pathname + "?" + action);
        let data = {};
        if (action === "address-availability") {
          const slug = url.searchParams.get("slug");
          if (slug === "offline-address") return route.fulfill({ status: 503, json: { error: "Availability is temporarily unavailable." } });
          if (slug === "old-slow-address") await new Promise(done => setTimeout(done, 1000));
          data = { slug, state: slug === wedding.slug ? "current" : slug === "taken-address" || slug === "old-slow-address" ? "taken" : "available" };
        }
        if (action === "get") data = { wedding: structuredClone(wedding) };
        if (action === "preview") data = interactivePreview(wedding, campaigns);
        if (action === "collection-capabilities") data = { currencies: [{ code: "KES", name: "Kenyan Shilling", methods: [{ name: "M-Pesa", markets: ["Kenya"] }] }] };
        if (action === "payout-methods") data = { methods: [] };
        if (action === "campaigns") data = { currency: wedding.currency, campaigns, summary: [], rows: [] };
        if (action === "extras-get") data = { faq: wedding.faq, travel: wedding.travel_info };
        if (action === "quote") data = { quote: { fee_minor: null, currency: wedding.currency, pending_date: true } };
        if (action === "starter-structure") {
          wedding.starter_structure = route.request().postDataJSON().structure;
          data = { structure: wedding.starter_structure };
        }
        if (action === "update") {
          const body = route.request().postDataJSON();
          assert.equal(body.attireNotes, seed.setup.content.attire, "task-scoped saves retain hidden attire guidance");
          if (body.slug === "taken-address") return route.fulfill({ status: 409, json: { error: "That address is already taken.", field: "wedding-slug" } });
          wedding = { ...wedding, couple_names: body.coupleNames, slug: body.slug, welcome_story: body.welcomeStory,
            cover_image_url: body.coverImageUrl,
            palette: body.palette, palette_names: body.paletteNames, currency: body.currency, page_content: body.pageContent || {},
            creation_content_reviewed: body.creationContentReviewed === true };
          data = { wedding: structuredClone(wedding) };
        }
        await route.fulfill({ json: data });
      });
      await page.goto(`${base}/wedding.html?id=${id}`, { waitUntil: "domcontentloaded" });
      const frame = page.frameLocator(".interactive-surface iframe");
      if (!wedding.couple_names) {
        await page.locator(".interactive-dialog").waitFor({ state: "visible" });
        assert.equal(await page.locator("#wedding-address").isVisible(), false, "internal draft address is not suggested before names");
        await frame.locator(".preview-address").waitFor({ state: "attached" });
        assert.equal(await frame.locator(".preview-address").isHidden(), true, "private renderer does not expose an internal draft address before names");
        if (process.env.INTERACTIVE_EVIDENCE_DIR) {
          await mkdir(process.env.INTERACTIVE_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({ path: resolve(process.env.INTERACTIVE_EVIDENCE_DIR, `fundamentals-${viewport.width}.png`), animations: "disabled", timeout: 60000 });
        }
        await page.locator("#couple-names").fill("Amina & David");
        assert.match(await page.locator("#slug-preview").textContent(), /amina-and-david\.joinourwedding\.site/);
        assert.equal(await page.locator("#wedding-slug").isVisible(), false, "names editor does not expose address fields");
        await page.locator("[data-guide-save]").click();
        await page.waitForFunction(() => !document.querySelector(".interactive-dialog").open);
      }
      await frame.locator("#couple-names").filter({ hasText: "Amina & David" }).waitFor();
      await frame.locator("#campaigns [data-primary-editor]").waitFor();
      assert.equal(await frame.locator("#bids").isVisible(), true);
      assert.match(await frame.locator("#campaigns").innerText(), /500,000/);
      assert.match(await frame.locator("#campaigns").innerText(), /KES\s*0/);
      assert.match(await frame.locator("#story").innerText(), /borrowed watering can/);
      assert.equal(await frame.locator("#prewedding-display .venue-card").count(), 5);
      assert.match(await frame.locator("#venues").innerText(), /Sample venue: Azure/);
      assert.equal(await frame.locator(".lookbook-art").count(), 4);
      assert.match(await frame.locator("#registry").innerText(), /slow Sunday breakfasts/);
      assert.match(await frame.locator("#sponsor-tiers").innerText(), /Golden celebration partner/);
      assert.match(await frame.locator("#vip-section").innerText(), /Garden lounge/);
      assert.match(await frame.locator("#info-section").innerText(), /Make a little weekend/);
      await frame.locator("#info-section [data-primary-editor]").waitFor();
      await frame.locator("#guestbook [data-primary-editor]").waitFor();
      assert.equal(await frame.locator("body").evaluate(() => window.extrasArrivedLate), true, "regression fixture delivers extras after main preview readiness");
      assert.equal(await frame.locator("#wish-form button").isDisabled(), true, "late wish form is effectively disabled");
      for (const section of ["welcome", "story", "info-section", "guestbook"]) {
        assert.equal(await frame.locator(`#${section} [data-primary-editor]`).count(), 1, "late initialization does not duplicate section controls");
      }
      assert.equal(await frame.locator("#ecard").isVisible(), true);
      assert.match(await frame.locator("#qrcode").innerText(), /not valid for entry/);
      assert.equal(await frame.getByText("Private preview. Guest actions are disabled. Review your content before publishing.", { exact: true }).count(), 1);
      assert.equal(await frame.getByText("Real activity is empty.", { exact: false }).count(), 0);
      assert.equal(await frame.locator("form button:not(:disabled)").count(), 0, "guest submission/payment buttons are effectively disabled");
      assert.equal(await frame.locator(".preview-edit:disabled").count(), 0, "editor controls remain actionable");
      for (const [section, kind, selector] of [
        ["welcome", "names", "#couple-names"], ["welcome", "date", "#wedding-date-display"],
        ["story", "story", "#welcome-story"], ["details", "palette", "#palette-preview"],
        ["details", "attire", "#attire-notes-display"], ["campaigns", "currency", "#campaigns-display"],
        ["registry", "registry", "#registry-list"], ["sponsor-tiers", "packages", "#tiers-display"],
        ["vip-section", "vip", "#vip-display"]
      ]) {
        const editor = frame.locator(`[data-edit-section-id="${section}"][data-edit-kind="${kind}"]`);
        assert.equal(await editor.getAttribute("data-edit-target"), selector);
        assert.equal(await editor.evaluate((button, target) => {
          let previous = button.previousElementSibling;
          while (previous?.classList.contains("preview-edit")) previous = previous.previousElementSibling;
          return previous === document.querySelector(target);
        }, selector), true, `${kind} editor sits directly beside its content rather than in a toolbar`);
      }
      assert.equal(await frame.locator(".preview-address [data-edit-kind=address]").count(), 1);
      assert.equal(await frame.locator("#welcome > [data-edit-kind=cover]").count(), 1);
      assert.equal(await frame.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "contextual controls do not create mobile/desktop overflow");
      assert.equal(await frame.locator("#nav-couple").evaluate(element => element.getBoundingClientRect().width > 100), true, "contextual music control does not squeeze the mobile couple names");
      const flow = await frame.locator("#wedding-content > section").evaluateAll(sections => sections.map(section => section.id));
      for (const [before, after] of [["prewedding", "info-section"], ["info-section", "rsvp"], ["rsvp", "ecard"],
        ["ecard", "campaigns"], ["campaigns", "registry"], ["registry", "bids"], ["bids", "ledger"],
        ["ledger", "sponsors"], ["sponsors", "sponsor-tiers"], ["sponsor-tiers", "vip-section"], ["seating", "guestbook"], ["guestbook", "share-section"]]) {
        assert.ok(flow.indexOf(before) < flow.indexOf(after), `${before} precedes ${after} in DOM and tab order`);
      }
      assert.equal(flow[flow.indexOf("sponsors") + 1], "sponsor-tiers", "Stand with us immediately follows Our sponsors");
      await frame.getByRole("button", { name: "Currency: KES", exact: true }).click();
      assert.equal(await page.locator('[data-guide-step="money"]').isVisible(), true);
      assert.equal(await page.locator("#payout-method").isVisible(), false, "currency excludes unrelated payout details");
      await page.keyboard.press("Escape");
      await frame.getByRole("button", { name: "Edit names", exact: true }).click();
      assert.equal(await page.locator("#couple-names").isVisible(), true);
      assert.equal(await page.locator('#welcome-story, #wedding-slug, #cover-image-url, [data-page-content]').evaluateAll(inputs => inputs.some(input => input.getClientRects().length > 0)), false, "names has no unrelated visible fields");
      assert.equal(await page.locator(".interactive-dialog input:visible, .interactive-dialog select:visible, .interactive-dialog textarea:visible").count(), 1);
      assert.equal(await page.locator("[data-guide-save]").evaluate(element => element.getBoundingClientRect().width >= 120), true, "focused dialog save label has usable width on mobile");
      await page.locator("#couple-names").fill("Amina & Joseph");
      assert.equal(await page.inputValue("#wedding-slug"), "amina-and-david", "existing named wedding is never auto-renamed");
      if (process.env.INTERACTIVE_EVIDENCE_DIR) {
        await page.screenshot({ path: resolve(process.env.INTERACTIVE_EVIDENCE_DIR, `names-editor-${viewport.width}.png`), animations: "disabled", timeout: 60000 });
      }
      await page.locator("[data-guide-save]").click();
      await page.waitForFunction(() => !document.querySelector(".interactive-dialog").open);
      assert.equal(wedding.welcome_story, seed.story, "names save preserves hidden story");
      assert.equal(wedding.cover_image_url, "https://images.example.test/our-cover.jpg", "names save preserves hidden cover");
      await frame.locator("#couple-names").filter({ hasText: "Amina & Joseph" }).waitFor();
      if (process.env.INTERACTIVE_EVIDENCE_DIR) {
        await mkdir(process.env.INTERACTIVE_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: resolve(process.env.INTERACTIVE_EVIDENCE_DIR, `prefilled-site-${viewport.width}.png`), animations: "disabled", timeout: 60000 });
      }
      await frame.locator("#story [data-primary-editor]").click();
      assert.equal(await page.locator("#welcome-story").isVisible(), true);
      assert.equal(await page.locator('#couple-names, #wedding-slug, #cover-image-url, [data-page-content]').evaluateAll(inputs => inputs.some(input => input.getClientRects().length > 0)), false, "story excludes names, address, cover and headings");
      assert.equal(await page.locator(".interactive-dialog input:visible, .interactive-dialog select:visible, .interactive-dialog textarea:visible").count(), 1);
      await page.locator("#welcome-story").fill("Our own true story, ready for our guests.");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".interactive-dialog").evaluate(element => element.open), true);
      assert.match(await page.locator("[data-close-warning]").innerText(), /Unsaved/);
      await page.locator("[data-close-editor]").focus();
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest(".interactive-dialog"))), true, "native modal traps focus");
      await page.keyboard.press("Tab");
      assert.equal(await page.locator("[data-close-editor]").evaluate(element => document.activeElement === element), true, "forward Tab wraps from the final control back to the dialog");
      if (process.env.INTERACTIVE_EVIDENCE_DIR) {
        await page.screenshot({ path: resolve(process.env.INTERACTIVE_EVIDENCE_DIR, `story-editor-${viewport.width}.png`), animations: "disabled", timeout: 60000 });
      }
      await page.locator("[data-guide-save]").click();
      await page.waitForFunction(() => !document.querySelector(".interactive-dialog").open);
      assert.equal(wedding.couple_names, "Amina & Joseph", "story save preserves hidden names");
      assert.equal(wedding.cover_image_url, "https://images.example.test/our-cover.jpg", "story save preserves hidden cover");
      await frame.locator('#story [data-edit-kind="wording"]').click();
      await page.locator('[data-page-content="story:0"]').fill("How we met");
      assert.equal(await page.locator("#welcome-story").isVisible(), false, "wording is separate from the story");
      await page.locator("[data-guide-save]").click();
      await page.waitForFunction(() => !document.querySelector(".interactive-dialog").open);
      await frame.getByRole("button", { name: "Edit wedding address", exact: true }).click();
      assert.equal(await page.locator("#wedding-slug").isVisible(), true);
      assert.equal(await page.locator("#couple-names").isVisible(), false);
      await page.locator("#wedding-slug").fill("taken-address");
      await page.locator('#address-availability[data-state="taken"]').waitFor();
      await page.locator("[data-guide-save]").click();
      await page.locator("#notice").filter({ hasText: "already taken" }).waitFor();
      assert.match(await page.locator("[data-editor-notice]").innerText(), /already taken/);
      assert.equal(await page.locator(".interactive-dialog").evaluate(element => element.open), true);
      await page.locator("#wedding-slug").fill("offline-address");
      await page.locator('#address-availability[data-state="error"]').waitFor();
      const oldResponse = page.waitForResponse(response => response.url().includes("slug=old-slow-address"));
      const oldRequest = page.waitForRequest(request => request.url().includes("slug=old-slow-address"));
      await page.locator("#wedding-slug").fill("old-slow-address");
      await oldRequest;
      await page.locator("#wedding-slug").fill("our-manual-address");
      await page.locator('#address-availability[data-state="available"]').waitFor();
      await oldResponse;
      assert.equal(await page.locator("#address-availability").getAttribute("data-state"), "available", "stale taken response cannot overwrite newer availability");
      await page.locator("[data-guide-save]").click();
      await page.waitForFunction(() => !document.querySelector(".interactive-dialog").open);
      await frame.locator("#couple-names").filter({ hasText: "Amina & Joseph" }).waitFor();
      await frame.locator("#story h2").filter({ hasText: "How we met" }).waitFor();
      assert.match(await frame.locator("#story").innerText(), /Our own true story/);
      assert.equal(wedding.slug, "our-manual-address");
      await frame.locator("#details [data-primary-editor]").click();
      await page.locator(".interactive-dialog").waitFor({ state: "visible" });
      assert.equal(await page.locator('[data-guide-step="theme"]').isVisible(), true);
      if (process.env.INTERACTIVE_EVIDENCE_DIR) {
        await mkdir(process.env.INTERACTIVE_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: resolve(process.env.INTERACTIVE_EVIDENCE_DIR, `editor-${viewport.width}.png`), animations: "disabled", timeout: 60000 });
      }
      const color = page.locator("#color-inputs input[type=color]").first();
      assert.equal(await page.locator("#attire-notes").isVisible(), false, "palette excludes dress guidance");
      await color.fill("#662244");
      await color.dispatchEvent("input");
      await page.locator("[data-guide-save]").click();
      await page.waitForFunction(() => !document.querySelector(".interactive-dialog").open);
      await frame.locator("#details [data-primary-editor]").waitFor();
      assert.equal(wedding.palette[0], "#662244");
      await frame.locator('#details [data-edit-kind="wording"]').click();
      await page.locator('[data-page-content="details:0"]').fill("");
      await page.locator("[data-guide-save]").click();
      await page.waitForFunction(() => !document.querySelector(".interactive-dialog").open);
      await page.reload({ waitUntil: "domcontentloaded" });
      await frame.locator("#story h2").filter({ hasText: "How we met" }).waitFor();
      assert.match(await frame.locator("#story").innerText(), /Our own true story/);
      assert.equal(await frame.locator("#details h2").isHidden(), true, "cleared optional heading stays removed after reload");
      assert.equal(await frame.locator(".lookbook-art").first().evaluate(element => getComputedStyle(element).fill), "rgb(102, 34, 68)");
      await page.keyboard.press("Escape");
      await frame.locator("#details [data-primary-editor]").click();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".interactive-dialog").evaluate(element => element.open), false);
      for (const [section, visible, unrelated] of [
        ["registry", "#registry-block", "#tiers-block, #vip-block, #song-requests-block"],
        ["sponsor-tiers", "#tiers-block", "#registry-block, #vip-block, #song-requests-block"],
        ["vip-section", "#vip-block", "#registry-block, #tiers-block, #song-requests-block"]
      ]) {
        await frame.locator(`#${section} [data-primary-editor]`).click();
        assert.equal(await page.locator(visible).isVisible(), true);
        assert.equal(await page.locator(unrelated).evaluateAll(elements => elements.some(element => element.getClientRects().length > 0)), false, "product editors do not expose other offerings");
        await page.keyboard.press("Escape");
      }
      await frame.locator("#bids [data-primary-editor]").click();
      assert.equal(await page.locator("#feature-song-requests").isDisabled(), true);
      assert.equal(await page.locator("#feature-song-requests").isChecked(), true);
      await page.keyboard.press("Escape");
      assert.deepEqual(guestCalls, [], "frame makes no guest, checkout or analytics API requests");
      assert.deepEqual(errors, []);
      if (process.env.INTERACTIVE_EVIDENCE_DIR) {
        await mkdir(process.env.INTERACTIVE_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: resolve(process.env.INTERACTIVE_EVIDENCE_DIR, `interactive-${viewport.width}.png`), animations: "disabled", timeout: 60000 });
      }
      await context.close();
    }
  } finally {
    await browser?.close();
    server.close();
  }
});
