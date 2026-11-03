import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { kesToMinor, minorToKes, fileFingerprint } from "../manual-payout-setup.js";

test("guided KES entry converts exact decimal strings to safe integer minor units without rounding or FX", () => {
  for (const [major, minor] of [["0", 0], ["0.01", 1], ["12.34", 1234], ["1000", 100000], ["90071992547409.91", Number.MAX_SAFE_INTEGER]]) {
    assert.equal(kesToMinor(major), minor);
    assert.equal(kesToMinor(minorToKes(minor)), minor);
  }
  for (const bad of ["", " ", "-1", "1.001", "1e2", "1,000", "01", ".5", "90071992547409.92", "Infinity"]) {
    assert.throws(() => kesToMinor(bad));
  }
});

test("evidence fingerprint is the actual local file SHA256, with bounded nonempty input", async () => {
  const contents = "Isolated synthetic evidence. Not an account or recipient.";
  assert.equal(await fileFingerprint(new Blob([contents])), createHash("sha256").update(contents).digest("hex"));
  await assert.rejects(fileFingerprint(new Blob([])), /nonempty/);
  await assert.rejects(fileFingerprint({ size: 20 * 1024 * 1024 + 1 }), /20 MiB/);
});
