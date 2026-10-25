# Production Verification Checklist

**Branch:** colyske-wedlink-wedding-platform (82 commits ahead of main)  
**Status:** Ready for Production after Supabase migrations applied  
**Critical:** These migrations MUST be applied before testing, or errors will persist

## Pre-Deployment Steps (For User/DevOps)

### 1. Apply Migrations to Supabase (WeddingSite Project)
```
Project Reference: lvvtgxspwvmdhqyoyqyy
```

Run these migrations in order (Supabase Dashboard → SQL Editor):
- ✓ 202610160001_finance_and_access.sql (already applied)
- ✓ 202610160002_protected_owner_identity.sql (already applied)
- ... (all previous migrations in order)
- ✓ 202610260009_qr_check_in_tracking.sql **[NEWLY FIXED]**

**Critical:** Migration 202610260009 now has CORRECT column names:
```sql
-- Fixed from:  guest_name, num_plus_ones, dietary_needs
-- To correct:  name, plus_ones, dietary_preference
```

**NOT applied:**
- ✗ 202610260010_list_published_weddings_rpc.sql (DELETED - duplicate)
- ✗ 202610260008_create_profiles_table.sql (DELETED - duplicate)

### 2. Verify Environment Variables
Add these to Vercel Production environment:
```
SUPABASE_URL=https://lvvtgxspwvmdhqyoyqyy.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key> (for backend only)
WEDDINGSITE_PUBLIC_ORIGIN=https://weddingsite-colyske.vercel.app
WEDDINGSITE_LIVE_PAYMENTS_ENABLED=false
WEDDINGSITE_PAYMENT_MODE=test
```

### 3. Update Supabase Auth Redirect URLs
In Supabase Dashboard → Authentication → URL Configuration:
Add redirect URLs:
- `https://weddingsite-colyske.vercel.app/signin.html`
- `https://weddingsite-colyske.vercel.app/`
- `https://weddingsite-colyske.vercel.app/account.html`

## Production Verification Tests (After Deploy)

### Test 1: Sign In as Owner
```
URL: https://weddingsite-colyske.vercel.app
Email: colyske@gmail.com
Password: [your password]
Expected: Dashboard loads, My Weddings list visible
```

✅ **PASS** / ❌ **FAIL** 

**Browser Console Errors:** ___________________________

---

### Test 2: Create New Wedding
```
Form Fill:
- Couple Names: "Sarah & John"
- Location: "Nairobi, Kenya"
- Wedding Date: [any future date]
- Currency: USD
- Max Guests: 150
- Colors: [keep defaults or customize]
- Venue: Church + Reception
```

✅ **PASS** / ❌ **FAIL** 

**Expected behavior:**
- Form submits without errors
- Success message appears: "✨ Sarah & John created successfully! Redirecting..."
- Auto-navigates to `/wedding.html?id=...&slug=...` within 1 second
- Wedding edit page loads successfully

**Errors if any:** ___________________________

---

### Test 3: Edit Wedding - Colors
```
On wedding edit page, scroll to Colors section:
- Click "Edit Palette"
- Change a color
- Save
Expected: Colors persist when page reloads
```

✅ **PASS** / ❌ **FAIL**

**Errors:** ___________________________

---

### Test 4: Edit Wedding - Venues
```
In Venues section:
- Edit venue name/time/map link
- Add new venue (green + button)
- Save
Expected: All venues persist on page reload
```

✅ **PASS** / ❌ **FAIL**

**Errors:** ___________________________

---

### Test 5: Publish Wedding
```
Scroll to top, click "Publish Wedding"
- Confirm fee is taken
Expected: Published status shows, "View Guest Site" button appears
```

✅ **PASS** / ❌ **FAIL**

**Errors:** ___________________________

---

### Test 6: View Guest Site (Publish)
```
After publishing, click "View Guest Site"
Expected: 
- Opens guest public site at `https://weddingsite-colyske.vercel.app/guest.html?slug=sarah-john`
- Shows couple names, dates, story, colors
- Leaderboard, ledger, guest list visible
```

✅ **PASS** / ❌ **FAIL**

**Errors:** ___________________________

---

### Test 7: RSVP as Guest
```
On guest site, scroll to RSVP section:
- Enter name, email
- Select "Will Attend" 
- Dietary: "Vegetarian"
- Plus ones: 2
- Submit
Expected: Success message, ledger updates
```

✅ **PASS** / ❌ **FAIL**

**Errors:** ___________________________

---

### Test 8: DJ Bid as Guest
```
On guest site, scroll to DJ Leaderboard:
- Enter song title, artist
- Bid amount: $50
- Submit
Expected: Bid appears in leaderboard
```

✅ **PASS** / ❌ **FAIL**

**Errors:** ___________________________

---

### Test 9: Account Settings
```
Dashboard or Wedding page:
- Click Account menu (👤 Account ▼)
- Click "Account Settings"
Expected: 
- Navigates to `/account.html`
- Shows profile (name, email, role)
- Shows role-based dashboards (Admin, SuperAdmin, Owner if applicable)
- Sign Out button functional
```

✅ **PASS** / ❌ **FAIL**

**Errors:** ___________________________

---

### Test 10: Error Handling
```
Close browser DevTools Network tab while on wedding edit page.
Check that:
- Any API error shows SPECIFIC message (not generic "The request could not be completed")
- Example messages: "You don't have permission", "Database service temporarily unavailable"
```

✅ **PASS** / ❌ **FAIL**

**Observed error messages:** ___________________________

---

### Test 11: No Console Errors
```
Open browser DevTools Console (F12) on each page:
- Dashboard
- Wedding edit
- Guest site  
- Account settings
Expected: No red error messages (warnings OK)
```

✅ **PASS** / ❌ **FAIL**

**Console errors if any:** ___________________________

---

### Test 12: Ampersand Fix (Character Encoding)
```
On dashboard:
- Create wedding with name: "Atieno & Otieno"
Expected: Shows correctly as "Atieno & Otieno" (not "Atieno &amp; Otieno")
Check on:
- Dashboard list
- Wedding edit page title
- Guest site title
- E-card
```

✅ **PASS** / ❌ **FAIL**

**Issues:** ___________________________

---

## Summary

**Total Tests:** 12  
**Passed:** _____ / 12  
**Failed:** _____ / 12  

**Critical Issues Found:** 
(List any blockers that prevent Production use)

1. _________________________________
2. _________________________________
3. _________________________________

**Nice-to-Have Issues Found:**
(List non-critical improvements)

1. _________________________________
2. _________________________________

## Sign-Off

- **Date Tested:** _______________
- **Tester:** _______________
- **Production URL:** https://weddingsite-colyske.vercel.app
- **Approved for Production:** ☐ YES ☐ NO

**Notes:**
___________________________________________________________________

---

## Technical Rollback Plan

If critical issues found:
1. Revert to previous Production commit
2. Roll back Supabase migrations (in reverse order)
3. Create new branch with fixes
4. Retest before attempting Production deploy again

## Files in This Deploy

### New/Modified
- `account.html` - Account settings page
- `dashboard.html` - Added Account menu link
- `dashboard.js` - Auto-navigate after wedding creation
- `wedding.html` - Added Account menu link
- `api/weddings.js` - Improved error handling
- `tests/navigation-fixes.test.js` - Regression tests
- `supabase/migrations/202610260009_qr_check_in_tracking.sql` - FIXED schema

### Deleted (conflicts/duplicates)
- `supabase/migrations/202610260008_create_profiles_table.sql`
- `supabase/migrations/202610260010_list_published_weddings_rpc.sql`

---

**Deployment Owner:** colyske  
**Deployment Status:** Ready (awaiting Production verification)  
**Last Updated:** 2026-10-26
