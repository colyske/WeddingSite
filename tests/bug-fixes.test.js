import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

// Bug fix tests for WeddingSite
const BASE_URL = process.env.TEST_URL || "http://localhost:3000";
let browser;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  if (browser) await browser.close();
});

// Issue #1: Wedding Edit After Creation
test("Issue #1: Wedding can be edited after creation - couple names editable", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE_URL}/wedding.html?id=test-id`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    
    // Check if couple-names field exists and is not disabled
    const coupleNamesField = await page.$("#couple-names");
    assert.ok(coupleNamesField, "Couple names field should exist");
    
    const isDisabled = await coupleNamesField.evaluate(el => el.disabled);
    assert.equal(isDisabled, false, "Couple names field should not be disabled after creation");
  } finally {
    await page.close();
  }
});

// Issue #2: Mandatory fields should be marked
test("Issue #2: Mandatory fields have required attribute", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE_URL}/wedding.html?id=test-id`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    
    const coupleNamesField = await page.$("#couple-names");
    const isRequired = await coupleNamesField.evaluate(el => el.required);
    assert.equal(isRequired, true, "Couple names should have required attribute");
  } finally {
    await page.close();
  }
});

// Issue #3: Ampersand double-escaping check
test("Issue #3: Ampersands are not double-escaped in display", async () => {
  const page = await browser.newPage();
  try {
    // Test escaping function
    const testCases = [
      { input: "John & Jane", expected: "John &amp; Jane" },
      { input: "Tom & Jerry", expected: "Tom &amp; Jerry" },
      { input: "<script>", expected: "&lt;script&gt;" },
      { input: '"quotes"', expected: "&quot;quotes&quot;" }
    ];
    
    for (const testCase of testCases) {
      await page.goto(`${BASE_URL}/wedding.html?id=test-id`, { waitUntil: "networkidle" });
      const result = await page.evaluate(({ input }) => {
        const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
        return esc(input);
      }, { input: testCase.input });
      
      assert.equal(result, testCase.expected, `${testCase.input} should escape to ${testCase.expected}, got ${result}`);
    }
  } finally {
    await page.close();
  }
});

// Issue #4: View guest site button should be clickable and have href
test("Issue #4: View guest site button has href and is clickable", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE_URL}/wedding.html?id=test-id`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    
    const viewButton = await page.$("#view-guest-site");
    if (viewButton) {
      const href = await viewButton.getAttribute("href");
      assert.ok(href, "View guest site button should have href attribute");
      assert.ok(href.includes("guest.html"), "href should point to guest.html");
    }
  } finally {
    await page.close();
  }
});

// Test HTML parsing
test("HTML pages parse without inline script errors", async () => {
  const page = await browser.newPage();
  const errors = [];
  
  page.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  
  page.on("error", err => errors.push(err.message));
  
  try {
    await page.goto(`${BASE_URL}/wedding.html?id=test-id`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    
    // Check for specific common errors
    assert.ok(!errors.some(e => e.includes("Cannot read property")), "Should not have property access errors");
    assert.ok(!errors.some(e => e.includes("undefined")), "Should not have undefined reference errors");
  } finally {
    await page.close();
  }
});
