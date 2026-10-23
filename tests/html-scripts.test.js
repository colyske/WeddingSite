import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pages = readdirSync(root).filter((f) => f.endsWith(".html"));

// A syntax error in a page's inline script stops every handler from attaching,
// so forms fall back to a native GET submit (page reloads and fields clear).
for (const page of pages) {
  test(`${page}: inline scripts parse`, () => {
    const html = readFileSync(join(root, page), "utf8");
    const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
    let m, n = 0;
    while ((m = re.exec(html))) {
      if (/type\s*=\s*["'](?!module|text\/javascript)/i.test(m[1])) continue;
      if (/type\s*=\s*["']module/i.test(m[1])) continue;
      // Wrapped in an async function so top-level await/return in page scripts still parse.
      assert.doesNotThrow(
        () => new vm.Script(`(async function(){\n${m[2]}\n})`, { filename: `${page}#${n}` }),
        `${page} inline script #${n} has a syntax error`
      );
      n++;
    }
  });
}

test("dashboard create form is intercepted and guarded against double submit", () => {
  const html = readFileSync(join(root, "dashboard.html"), "utf8");
  assert.match(html, /getElementById\("create-form"\)|\$\("create-form"\)\.addEventListener\("submit"/);
  assert.match(html, /e\.preventDefault\(\)/);
  assert.match(html, /if \(btn\.disabled\) return;/);
  assert.equal(html.includes("form.reset()"), true);
  const resetIdx = html.indexOf("form.reset()");
  assert.ok(html.slice(resetIdx - 200, resetIdx).includes("Wedding created"), "reset only after success");
});
