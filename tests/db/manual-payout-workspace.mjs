// Isolated rollback fixture: real policies and exact statement/debit workflow.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const fixture = readFileSync(new URL("./manual-payout-readiness.sql", import.meta.url), "utf8");
const extra = readFileSync(new URL("./manual-payout-workspace.sql", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres",
  "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
  input: fixture.replace(/rollback;\s*$/, extra + "\nrollback;"), encoding: "utf8"
});
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\nLast fixture output:\n${result.stdout.slice(-5000)}`);
console.log("Couple intents reserve nothing OFF; atomic staff review, replay, privacy, normal/Owner-solo claim and exact paid reconciliation passed.");
