import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const read = name => readFileSync(new URL(name, import.meta.url), "utf8");
const input = read("./manual-payout-readiness.sql").replace(/rollback;\s*$/,
  () => read("./withdrawal-policy.sql") + read("./payout-recipient.sql") + "\nrollback;");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
  { encoding: "utf8", input });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Private recipient snapshots, stale consent, edits after claim, actual name matching, durable mismatch Hold, replay and role boundaries passed.");
