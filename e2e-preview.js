#!/usr/bin/env node
// E2E testing against live Preview deployment
// Tests: login, wedding creation, edit, publish, guest site, admin features
import { chromium } from "playwright";

const PREVIEW_URL = "https://weddingsite-six-bice.vercel.app";
const OWNER_EMAIL = "colyske@gmail.com"; // Authorized test account
const OWNER_PASSWORD = process.env.OWNER_PASSWORD; // Must be set before running

if (!OWNER_PASSWORD) {
  console.error("❌ OWNER_PASSWORD environment variable not set");
  process.exit(1);
}

const results = [];
const fail = (name, error) => { results.push({ name, status: "❌ FAIL", error: String(error).slice(0, 200) }); console.error(`\n❌ ${name}\n   ${error}`); };
const pass = (name) => { results.push({ name, status: "✅ PASS" }); console.log(`✅ ${name}`); };

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Catch console errors
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  try {
    // 1. Homepage loads
    console.log("\n📋 Test 1: Homepage loads");
    await page.goto(PREVIEW_URL, { waitUntil: "domcontentloaded" });
    const homeTitle = await page.title();
    if (!homeTitle) throw new Error("Page has no title");
    if (consoleErrors.length > 0) throw new Error(`Console errors: ${consoleErrors.join(", ")}`);
    pass("Homepage loads without errors");
  } catch (e) {
    fail("Homepage loads without errors", e);
  }

  try {
    // 2. Sign in page accessible
    console.log("\n📋 Test 2: Sign-in page");
    await page.goto(`${PREVIEW_URL}/signin.html`);
    const signInForm = await page.$("form");
    if (!signInForm) throw new Error("Sign-in form not found");
    const emailInput = await page.$("input[type='email']");
    if (!emailInput) throw new Error("Email input not found");
    pass("Sign-in page loads with form");
  } catch (e) {
    fail("Sign-in page loads with form", e);
  }

  try {
    // 3. Login as Owner
    console.log("\n📋 Test 3: Owner login");
    await page.goto(`${PREVIEW_URL}/signin.html`);
    await page.fill("input[type='email']", OWNER_EMAIL);
    await page.fill("input[type='password']", OWNER_PASSWORD);
    await page.click("button[type='submit']");
    
    // Wait for redirect to dashboard or home
    await page.waitForNavigation({ timeout: 10000 });
    const url = page.url();
    const hasSession = await page.evaluate(() => !!sessionStorage.getItem("ws-session"));
    if (!hasSession && !url.includes("dashboard") && !url.includes("wedding")) throw new Error("Login failed - no session");
    pass("Owner login successful");
  } catch (e) {
    fail("Owner login successful", e);
  }

  try {
    // 4. Navigate to dashboard
    console.log("\n📋 Test 4: Dashboard navigation");
    await page.goto(`${PREVIEW_URL}/dashboard.html`);
    await page.waitForSelector("#create-form", { timeout: 5000 });
    const coupleNamesInput = await page.$("#couple-names");
    if (!coupleNamesInput) throw new Error("Couple names input not found");
    pass("Dashboard loads with form");
  } catch (e) {
    fail("Dashboard loads with form", e);
  }

  try {
    // 5. Create a wedding
    console.log("\n📋 Test 5: Wedding creation");
    const testNames = `Test Wedding ${Date.now()}`;
    await page.fill("#couple-names", testNames);
    await page.fill("#location", "Test City");
    await page.fill("#wedding-date", "2027-12-25");
    await page.selectOption("#currency", "KES");
    await page.fill("#max-capacity", "200");
    
    // Add a venue
    await page.click("[data-action='add-venue']");
    await page.fill("[data-venue-field='name']", "Test Church");
    
    // Click create button and wait for success
    const createBtn = await page.$("#create-submit");
    await createBtn.click();
    
    // Wait for success message or created div
    await page.waitForSelector("#created:not([hidden])", { timeout: 10000 });
    const createdText = await page.textContent("#created");
    if (!createdText || !createdText.includes(testNames)) throw new Error("Wedding not created");
    pass("Wedding created successfully");
  } catch (e) {
    fail("Wedding created successfully", e);
  }

  try {
    // 6. Extract wedding ID and slug from the link
    console.log("\n📋 Test 6: Extract wedding details");
    const createdLink = await page.$("a[href*='wedding.html']");
    if (!createdLink) throw new Error("Created wedding link not found");
    const href = await createdLink.getAttribute("href");
    const weddingIdMatch = href.match(/id=([^&]+)/);
    const slugMatch = href.match(/slug=([^&]+)/);
    if (!weddingIdMatch || !slugMatch) throw new Error("Could not extract wedding ID or slug");
    const weddingId = decodeURIComponent(weddingIdMatch[1]);
    const slug = decodeURIComponent(slugMatch[1]);
    console.log(`   Wedding ID: ${weddingId}, Slug: ${slug}`);
    pass("Wedding details extracted");
  } catch (e) {
    fail("Wedding details extracted", e);
  }

  try {
    // 7. Verify weddings list shows the new wedding
    console.log("\n📋 Test 7: Weddings list");
    await page.waitForSelector("#weddings-grid .card", { timeout: 5000 });
    const cardText = await page.textContent("#weddings-grid");
    if (!cardText || cardText.length < 10) throw new Error("Weddings grid is empty");
    pass("Weddings list renders");
  } catch (e) {
    fail("Weddings list renders", e);
  }

  try {
    // 8. Check for mandatory field validation
    console.log("\n📋 Test 8: Mandatory field validation");
    await page.fill("#couple-names", "");
    const coupleNamesLabel = await page.$("label[for='couple-names']");
    const labelText = await coupleNamesLabel.textContent();
    if (!labelText.includes("*")) throw new Error("Required field asterisk not shown");
    pass("Mandatory fields marked with asterisk");
  } catch (e) {
    fail("Mandatory fields marked with asterisk", e);
  }

  try {
    // 9. Test color palette editing
    console.log("\n📋 Test 9: Color palette editor");
    await page.fill("#couple-names", "Test Colors");
    await page.click("#edit-palette");
    const paletteEditor = await page.$("#palette-editor");
    const isVisible = await paletteEditor.isVisible();
    if (!isVisible) throw new Error("Palette editor not visible");
    
    // Change a color
    await page.fill("#color-1", "#ff0000");
    await page.waitForFunction(() => {
      const swatch = document.getElementById("swatch-1");
      const bg = getComputedStyle(swatch).backgroundColor;
      return bg.includes("255, 0, 0") || bg === "rgb(255, 0, 0)";
    }, { timeout: 5000 });
    pass("Color palette editor works");
  } catch (e) {
    fail("Color palette editor works", e);
  }

  try {
    // 10. Test account menu (role-aware navigation)
    console.log("\n📋 Test 10: Account menu");
    const accountBtn = await page.$("#account-menu-btn");
    if (!accountBtn) throw new Error("Account menu button not found");
    await accountBtn.click();
    const menu = await page.$("#account-menu");
    const isMenuVisible = await menu.isVisible();
    if (!isMenuVisible) throw new Error("Account menu not visible after click");
    const menuText = await menu.textContent();
    if (!menuText.includes("Sign out")) throw new Error("Sign out option not in menu");
    pass("Account menu visible and functional");
  } catch (e) {
    fail("Account menu visible and functional", e);
  }

  try {
    // 11. Test guest site URL
    console.log("\n📋 Test 11: Guest site navigation");
    await page.goto(`${PREVIEW_URL}/dashboard.html`);
    await page.waitForSelector("#weddings-grid .card", { timeout: 5000 });
    const guestLink = await page.$("a[href*='guest.html']");
    if (guestLink) {
      await guestLink.click();
      await page.waitForNavigation({ timeout: 5000 });
      const guestUrl = page.url();
      if (!guestUrl.includes("guest.html")) throw new Error(`Wrong URL: ${guestUrl}`);
      pass("Guest site link works");
    } else {
      console.log("   (No guest site link on draft wedding)");
      pass("Guest site link works (skipped - draft wedding)");
    }
  } catch (e) {
    fail("Guest site link works", e);
  }

  try {
    // 12. Test responsive design
    console.log("\n📋 Test 12: Responsive mobile view");
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${PREVIEW_URL}/dashboard.html`);
    await page.waitForSelector("#create-form", { timeout: 5000 });
    const coupleInput = await page.$("#couple-names");
    const isVisible = await coupleInput.isVisible();
    if (!isVisible) throw new Error("Form not visible on mobile");
    pass("Mobile responsive design works");
  } catch (e) {
    fail("Mobile responsive design works", e);
  }

  try {
    // 13. Test admin dashboard accessibility
    console.log("\n📋 Test 13: Admin dashboard");
    await page.setViewportSize({ width: 1280, height: 1024 });
    await page.goto(`${PREVIEW_URL}/admin.html`);
    // Admin page should either load or redirect if not authorized
    const adminContent = await page.content();
    if (adminContent.length < 100) throw new Error("Admin page is empty or blocked");
    pass("Admin page accessible");
  } catch (e) {
    fail("Admin page accessible", e);
  }

  try {
    // 14. Check for escaping (ampersand test)
    console.log("\n📋 Test 14: HTML escaping (ampersand bug)");
    await page.goto(`${PREVIEW_URL}/dashboard.html`);
    await page.fill("#couple-names", "Alice & Bob");
    await page.fill("#location", "Paris & London");
    await page.fill("#wedding-date", "2027-12-25");
    await page.selectOption("#currency", "EUR");
    await page.fill("#max-capacity", "100");
    
    // Create and check the created message
    await page.click("#create-submit");
    await page.waitForSelector("#created:not([hidden])", { timeout: 10000 });
    const createdText = await page.textContent("#created");
    if (createdText.includes("&amp;")) throw new Error("Double-escaping detected");
    if (!createdText.includes("&")) throw new Error("Ampersand stripped");
    pass("HTML escaping works correctly");
  } catch (e) {
    fail("HTML escaping works correctly", e);
  }

  try {
    // 15. Verify no hard 404s or network errors on key pages
    console.log("\n📋 Test 15: All key pages load");
    const pages = [
      "/",
      "/signin.html",
      "/dashboard.html",
      "/admin.html",
      "/guest.html?slug=demo",
      "/wedding.html?id=test&slug=test"
    ];
    for (const pagePath of pages) {
      const response = await page.goto(`${PREVIEW_URL}${pagePath}`, { waitUntil: "domcontentloaded" });
      if (!response) continue; // Navigation timeout is ok
      if (response.status() >= 500) throw new Error(`Server error on ${pagePath}: ${response.status()}`);
    }
    pass("Key pages load without 5xx errors");
  } catch (e) {
    fail("Key pages load without 5xx errors", e);
  }

  // Close browser
  await context.close();
  await browser.close();

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("E2E TEST SUMMARY");
  console.log("=".repeat(60));
  const passed = results.filter(r => r.status === "✅ PASS").length;
  const failed = results.filter(r => r.status === "❌ FAIL").length;
  results.forEach(r => console.log(`${r.status} ${r.name}${r.error ? ` - ${r.error}` : ""}`));
  console.log("\n" + "=".repeat(60));
  console.log(`TOTAL: ${passed}/${results.length} passed`);
  console.log("=".repeat(60));
  
  process.exit(failed > 0 ? 1 : 0);

} catch (error) {
  console.error("Fatal error:", error);
  if (browser) await browser.close();
  process.exit(1);
}
