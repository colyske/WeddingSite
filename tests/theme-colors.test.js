import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("custom palette ink remains readable without changing saved swatches", async () => {
  const properties = {};
  const window = {};
  vm.runInNewContext(await readFile(new URL("../theme-colors.js", import.meta.url), "utf8"), {
    window, document: { documentElement: { style: { setProperty: (key, value) => { properties[key] = value; } } } }
  });
  const { apply, contrast } = window.WSTheme;
  for (const palette of [
    ["#ffffff", "#ffffff", "#ffffff"], ["#000000", "#000000", "#000000"],
    ["#ffff00", "#00ffff", "#ff00ff"], ["invalid", null], []
  ]) {
    const saved = [...palette];
    apply(palette);
    assert.deepEqual(palette, saved);
    for (const color of Object.values(properties)) {
      for (const background of ["#ebe7da", "#edece3", "#f6f3ec", "#fbfaf6", "#ffffff"]) {
        assert.ok(contrast(color, background) >= 4.5, `${color} on ${background}`);
      }
      assert.ok(contrast("#ffffff", color) >= 7, "white button/venue/countdown text stays readable");
      assert.ok(contrast("#e0e4db", color) >= 4.5, "secondary text on dark custom surfaces stays readable");
    }
  }
});
