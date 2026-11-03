import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const base = readFileSync(new URL("./manual-payout-readiness.sql", import.meta.url), "utf8");
const shared = readFileSync(new URL("./manual-payout-shared.sql", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres",
  "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input: base.replace(/rollback;\s*$/, () => shared + "\nrollback;") });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-5000)}`);
console.log("Shared manual attribution: no global balance/statements, exact verified net, cross-scope commitments, normal/solo exact transfer evidence, holds, role isolation and cross-channel duplicate protection passed.");
