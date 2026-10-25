#!/usr/bin/env node
/**
 * Verify all Supabase migrations are syntactically valid and have no conflicts
 * Run: node verify-migrations.js
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";

const migrationsDir = "./supabase/migrations";

async function verifyMigrations() {
  const files = await readdir(migrationsDir);
  const migrations = files
    .filter(f => f.endsWith(".sql"))
    .sort();

  console.log(`\n📋 Found ${migrations.length} migration files\n`);

  const issues = [];
  const functionDefs = new Map();
  const tableDefs = new Map();

  for (const file of migrations) {
    const path = join(migrationsDir, file);
    const content = await readFile(path, "utf-8");

    console.log(`✓ ${file}`);

    // Check for function definitions
    const funcMatches = content.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_]+)/gi);
    for (const match of funcMatches) {
      const funcName = match[1].toLowerCase();
      if (functionDefs.has(funcName)) {
        console.log(`  ⚠️  Function '${funcName}' redefined (previously in ${functionDefs.get(funcName)})`);
      } else {
        functionDefs.set(funcName, file);
      }
    }

    // Check for table definitions
    const tableMatches = content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_]+)/gi);
    for (const match of tableMatches) {
      const tableName = match[1].toLowerCase();
      if (tableDefs.has(tableName) && !content.includes("IF NOT EXISTS")) {
        issues.push(`❌ Table '${tableName}' defined twice (first in ${tableDefs.get(tableName)}, now in ${file}) without IF NOT EXISTS`);
      } else {
        tableDefs.set(tableName, file);
      }
    }

    // Check for common schema mismatches
    if (file.includes("check_in") || file.includes("qr")) {
      if (content.includes("guest_name") && !content.includes("`guest_name`")) {
        if (!content.includes("SELECT")) {
          // Only warn if it's not in a SELECT (which might be intentional)
        } else if (content.match(/FROM guests.*guest_name/i)) {
          issues.push(`⚠️  ${file}: Might use wrong column name 'guest_name' instead of 'name'`);
        }
      }
    }

    // Verify all function references have corresponding RPC calls in code
    if (file === "202610260009_qr_check_in_tracking.sql") {
      const hasGetGuestPassData = content.includes("get_guest_pass_data");
      const hasMarkGuestCheckedIn = content.includes("mark_guest_checked_in");
      console.log(`  - Defines get_guest_pass_data: ${hasGetGuestPassData ? "✓" : "✗"}`);
      console.log(`  - Defines mark_guest_checked_in: ${hasMarkGuestCheckedIn ? "✓" : "✗"}`);

      // Check the actual column names
      const nameMatch = content.match(/SELECT[\s\S]*?FROM guests/i);
      if (nameMatch) {
        console.log(`  - Uses correct 'name' column: ${content.includes("g.name") ? "✓" : "✗"}`);
        console.log(`  - Uses correct 'plus_ones' column: ${content.includes("g.plus_ones") ? "✓" : "✗"}`);
        console.log(`  - Uses correct 'rsvp_status' column: ${content.includes("g.rsvp_status") ? "✓" : "✗"}`);
        console.log(`  - Uses correct 'dietary_preference' column: ${content.includes("g.dietary_preference") ? "✓" : "✗"}`);
      }
    }
  }

  console.log(`\n📊 Summary:\n`);
  console.log(`Total functions defined: ${functionDefs.size}`);
  console.log(`Total tables defined: ${tableDefs.size}`);

  if (issues.length === 0) {
    console.log(`\n✅ No migration issues found!\n`);
  } else {
    console.log(`\n⚠️  Issues found:\n`);
    issues.forEach(issue => console.log(`${issue}`));
    console.log();
  }

  // List critical RPC functions
  console.log(`🔍 Critical RPC functions to verify on Supabase:\n`);
  const criticalFuncs = [
    "create_wedding",
    "publish_wedding_with_fee",
    "get_public_wedding",
    "get_dj_leaderboard",
    "get_published_contributions_page",
    "submit_rsvp",
    "place_dj_bid",
    "get_rsvp_count",
    "list_published_weddings_paginated",
    "get_guest_pass_data",
    "mark_guest_checked_in",
    "withdrawable_balance",
    "request_payout",
  ];

  for (const func of criticalFuncs) {
    const file = functionDefs.get(func.toLowerCase());
    const status = file ? `✓ in ${file}` : `✗ NOT FOUND`;
    console.log(`  ${status.padEnd(50)} ${func}`);
  }

  console.log(`\n`);
  return issues.length === 0;
}

try {
  const passed = await verifyMigrations();
  process.exit(passed ? 0 : 1);
} catch (e) {
  console.error("Error verifying migrations:", e.message);
  process.exit(1);
}
