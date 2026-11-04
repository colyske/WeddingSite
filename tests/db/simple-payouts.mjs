import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const base = readFileSync(new URL("./manual-payout-readiness.sql", import.meta.url), "utf8");
const tests = readFileSync(new URL("./simple-payouts.sql", import.meta.url), "utf8");
const result = spawnSync("docker", ["exec", "-i", "supabase_db_weddingsite", "psql", "-U", "postgres", "-d", "postgres",
  "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", input: base.replace(/rollback;\s*$/, () => tests + "\nrollback;") });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout.slice(-6000)}`);
console.log("Simple operator payouts: atomic reserve, Hold/Processing/Paid, normal/Owner solo, exact retries, fee/KYC/obligations, cross-path holds and unchanged OFF gates passed.");
