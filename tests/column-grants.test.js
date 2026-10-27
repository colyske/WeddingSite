import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("authenticated may update every column the update API patches", () => {
  const sql = readFileSync(new URL("../supabase/migrations/202610270003_grant_wedding_column_updates.sql", import.meta.url), "utf8");
  for (const col of ["time_zone", "attire_notes", "background_music_url"]) assert.match(sql, new RegExp(`grant update \\([^)]*\\b${col}\\b`));
});
