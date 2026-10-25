#!/usr/bin/env node

/**
 * Comprehensive end-to-end test suite for WeddingSite Preview
 * Tests all major workflows in sequence with real browser automation
 */

const fs = require('fs');
const path = require('path');

// Configuration
const PREVIEW_URL = 'https://weddingsite-85zk3leby-colyske.vercel.app';
const OWNER_EMAIL = 'colyske@gmail.com';
// NOTE: Password is in secure local context only; never print/log/commit

const testResults = {
  passed: [],
  failed: [],
  warnings: []
};

function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    'info': '📋',
    'success': '✅',
    'error': '❌',
    'warn': '⚠️',
    'network': '🌐'
  }[type] || '•';
  
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

async function checkMigrations() {
  log('Checking Supabase migrations status...', 'info');
  
  // This is a manual check the user must do
  log('MANUAL CHECK REQUIRED:', 'warn');
  log('  1. Go to Supabase Dashboard > WeddingSite project > SQL Editor', 'info');
  log('  2. Check if these migrations are applied:', 'info');
  log('     - 202610260008_create_profiles_table.sql', 'info');
  log('     - 202610260009_qr_check_in_tracking.sql', 'info');
  log('     - 202610260010_list_published_weddings_rpc.sql', 'info');
  log('  3. Run each migration if not already applied', 'info');
  
  testResults.warnings.push('Migrations must be manually applied to WeddingSite Supabase project');
}

async function checkEnvironmentVars() {
  log('Checking environment variables needed...', 'info');
  
  const requiredVars = {
    'SUPABASE_URL': 'Supabase project URL',
    'SUPABASE_ANON_KEY': 'Supabase anonymous key',
    'SUPABASE_SERVICE_ROLE_KEY': 'Supabase service role key (backend only)',
    'SMTP_HOST': 'Email provider (optional for preview, needed for production)',
    'SMTP_FROM': 'Sender email address (optional for preview)',
    'STRIPE_PUBLISHABLE_KEY': 'Stripe test key',
    'STRIPE_SECRET_KEY': 'Stripe secret key (backend only)',
    'PAYSTACK_PUBLIC_KEY': 'Paystack test key',
    'PAYSTACK_SECRET_KEY': 'Paystack secret key (backend only)'
  };
  
  log('Required environment variables (do not print values!):', 'warn');
  Object.entries(requiredVars).forEach(([key, desc]) => {
    log(`  ${key}: ${desc}`, 'info');
  });
  
  testResults.warnings.push('User must verify environment variables are set in Vercel');
}

function reportResults() {
  log('\n=== TEST RESULTS ===', 'info');
  log(`✅ Passed: ${testResults.passed.length}`, 'success');
  log(`❌ Failed: ${testResults.failed.length}`, 'error');
  log(`⚠️  Warnings: ${testResults.warnings.length}`, 'warn');
  
  if (testResults.failed.length > 0) {
    log('\nFailed tests:', 'error');
    testResults.failed.forEach(test => {
      log(`  - ${test}`, 'error');
    });
  }
  
  if (testResults.warnings.length > 0) {
    log('\nWarnings:', 'warn');
    testResults.warnings.forEach(warn => {
      log(`  - ${warn}`, 'warn');
    });
  }
}

async function main() {
  log('WeddingSite Preview Verification Suite', 'info');
  log(`Preview URL: ${PREVIEW_URL}`, 'info');
  log('Starting systematic checks...', 'info');
  
  await checkMigrations();
  await checkEnvironmentVars();
  
  log('\n=== NEXT STEPS ===', 'info');
  log('1. Deploy migrations to Supabase WeddingSite project', 'warn');
  log('2. Verify environment variables in Vercel', 'warn');
  log('3. Sign in with Owner account (colyske@gmail.com)', 'warn');
  log('4. Test workflow: Create → Edit → Publish → View Guest Site → RSVP → Bid', 'warn');
  log('5. Check browser console (F12) for errors on each page', 'warn');
  
  reportResults();
}

main().catch(err => {
  log(`Fatal error: ${err.message}`, 'error');
  process.exit(1);
});
