import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("public wedding browse RPC exposes only published summaries through definer access", async () => {
  const sql = await readFile(new URL("../supabase/migrations/202610270001_secure_public_wedding_browse.sql", import.meta.url), "utf8");
  assert.match(sql, /security definer/i);
  assert.match(sql, /set row_security\s*=\s*off/i);
  assert.match(sql, /where w\.published_at is not null/i);
  assert.match(sql, /limit least\(greatest\(coalesce\(p_limit, 12\), 1\), 50\)/i);
  assert.match(sql, /grant execute on function public\.list_published_weddings_paginated\(integer, integer\) to anon, authenticated/i);
});
