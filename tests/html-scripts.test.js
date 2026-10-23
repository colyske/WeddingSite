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
      assert.doesNotThrow(
        () => new vm.Script(m[2], { filename: `${page}#${n}` }),
        `${page} inline script #${n} has a syntax error`
      );
      n++;
    }
  });
}

test("dashboard has no inline script and the form cannot submit natively", () => {
  const html = readFileSync(join(root, "dashboard.html"), "utf8");
  assert.match(html, /<script src="dashboard\.js"><\/script>/);
  assert.match(html, /<form id="create-form"[^>]*novalidate[^>]*onsubmit="return false"/);
  assert.doesNotMatch(html, /<script>(?!\s*<\/script>)/);
});
