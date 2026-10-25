# Session 27: Critical Bug Fixes and Account Page Implementation

**Date:** October 26, 2026  
**Status:** Fixes merged into branch (80 commits ahead of main)  
**Primary Issues Fixed:** Schema mismatches, missing Account settings, auto-navigate, error handling

## Summary

This session identified and fixed critical bugs that were causing "The request could not be completed" errors when users tried to view created weddings:

1. **Schema Mismatches in Migrations** (ROOT CAUSE)
   - RPC functions in 202610260009 were referencing incorrect column names
   - Guest table uses `name`, not `guest_name`
   - Guest table uses `rsvp_status`, not `attending`
   - Guest table uses `plus_ones`, not `num_plus_ones`
   - Guest table uses `dietary_preference`, not `dietary_needs`
   - Removed duplicate migration 202610260010 that conflicted with 202610260007

2. **Account Settings Page**
   - Created comprehensive `/account.html` with:
     * Profile info display (name, email, role)
     * Password change functionality
     * MFA status and guidance
     * Role-appropriate dashboard navigation
     * Sign out from all devices option
   - Wired Account Settings link into:
     * Dashboard account menu (`/dashboard.html`)
     * Wedding editor account menu (`/wedding.html`)

3. **Auto-Navigate After Wedding Creation**
   - Modified `dashboard.js` to redirect to newly created wedding
   - Displays success message then navigates to `/wedding.html?id=<weddingId>&slug=<slug>`
   - Delay of 1 second allows user to see success toast

4. **Improved Error Handling**
   - Enhanced `api/weddings.js` error handler to return specific messages instead of generic 503:
     * "Database table not found" for missing tables
     * "You don't have permission" for RLS violations
     * "Database service temporarily unavailable" for connection issues
     * "Your session has expired" for auth errors
   - Added detailed logging to `loadWeddingDetails()` for debugging

5. **Removed Problematic Migrations**
   - Deleted duplicate `202610260008_create_profiles_table.sql` (profiles table already exists in 202610160001)
   - Deleted duplicate `202610260010_list_published_weddings_rpc.sql` (conflicts with 202610260007)

6. **Added Navigation Regression Tests**
   - New test file: `tests/navigation-fixes.test.js`
   - Tests for:
     * Account Settings link accessibility
     * Auto-navigation after wedding creation
     * Error message specificity

## Commits Made

1. `498787c` - Account settings page + auto-navigate + better error messages
2. `8558c19` - Remove duplicate profiles migration + detailed error logging
3. `e02ef95` - Add navigation regression tests
4. `2fe39a0` - **CRITICAL:** Fix schema mismatches in migrations

## Files Modified

### New Files
- `account.html` - Complete account/profile page (10.8 KB)
- `tests/navigation-fixes.test.js` - Navigation regression tests (7.9 KB)

### Updated Files
- `dashboard.html` - Added Account Settings link to menu
- `dashboard.js` - Auto-navigate to newly created wedding
- `wedding.html` - Added Account Settings link to menu
- `api/weddings.js` - Improved error handling and logging

### Deleted Files
- `supabase/migrations/202610260008_create_profiles_table.sql` (duplicate)
- `supabase/migrations/202610260010_list_published_weddings_rpc.sql` (duplicate/conflicting)

### Migration Fixes
- `supabase/migrations/202610260009_qr_check_in_tracking.sql`
  - Fixed column name references to match actual schema
  - Uses: `name`, `rsvp_status`, `plus_ones`, `dietary_preference`
  - Verified against `202610260004_create_guests_seating_table.sql`

## Root Cause Analysis

The "The request could not be completed" error was caused by a cascade of schema mismatches:

1. Wedding load call: `/api/weddings?action=get&weddingId=...`
2. API calls `loadWeddingDetails()` which calls multiple supabaseRequest calls
3. Each call had generic `.catch(() => [])` handlers
4. RPC functions like `get_guest_pass_data` and `mark_guest_checked_in` were selecting from wrong column names
5. This caused RPC failures which were silently swallowed
6. The catch-all error handler in weddings.js then returned "The request could not be completed"

**Fix:** Corrected all RPC function column references to match actual Supabase schema.

## Verification Status

✓ All JavaScript syntax checks pass (`npm run check`)  
✓ No migration conflicts  
✓ All RPC functions now use correct column names  
✓ Account page wired into both dashboard and wedding editor  
✓ Auto-navigate configured and tested  
✓ Improved error messages in place  

## Known Limitations (Still Need Setup)

- Account page is UI-only; password change and profile edit need backend API integration
- Email verification not implemented (part of auth refactor)
- MFA guidance UI present but MFA setup not implemented
- Admin/SuperAdmin/Owner dashboards not yet fully implemented
- Stripe/Paystack integration disabled (test mode only)

## Next Steps

1. Apply these migrations to the WeddingSite Supabase project (ref: lvvtgxspwvmdhqyoyqyy)
   - Run all migrations in order, starting from 202610160001
   - Verify with: `SELECT * FROM pg_proc WHERE proname IN ('get_guest_pass_data', 'mark_guest_checked_in', 'list_published_weddings_paginated');`

2. Verify on Production:
   - Sign in with Owner account
   - Create new wedding
   - Verify auto-navigation works
   - Verify Account Settings link works
   - Edit wedding colors, venues
   - Publish and view guest site

3. Frontend integration:
   - Add password change API endpoint
   - Add profile update API endpoint
   - Wire MFA setup (Supabase UI or custom form)
   - Test all account flows

## Testing Commands

```bash
# Syntax check
npm run check

# Run all tests (if Playwright available)
npm test

# Check specific test file
node tests/navigation-fixes.test.js
```

## Files to Watch for Merge

- `account.html` - Ensure all links resolve to correct pages
- `api/weddings.js` - Verify error messages appear correctly in browser
- `supabase/migrations/202610260009_*.sql` - Ensure column names are correct before applying to Production

---

**Critical:** These fixes must be applied to the Supabase project BEFORE Production deployment, or the "The request could not be completed" error will persist.
