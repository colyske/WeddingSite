# Production Bugs - Session 28 Fixes

User tested on Production and reported 12 critical issues. Fix each systematically, verify in real browser on Production URL, add regression tests.

## Issue Tracking

### 1. Palette Validation Error
**Status:** 🔴 BLOCKED  
**Issue:** Saving wedding edits fails with "Choose one to four hex colors."  
**Root Cause:** 
- Form sends colors from `span.style.background` which might be CSS values (rgb(), names, etc)
- API validation expects `#RRGGBB` format exactly
- Color input elements may return computed CSS color values instead of hex codes

**Fix Needed:**
- Validate palette colors on the form before sending (convert/validate to hex)
- Ensure color picker always returns valid #RRGGBB format
- API should handle edge cases gracefully

**Files to Modify:**
- wedding.html (palette form logic)
- api/weddings.js (palette validation)

**Test:** 
- [ ] Create wedding, edit palette, save successfully
- [ ] Rainbow test (1, 2, 3, 4 colors)
- [ ] Browser test that saves and verifies persistence

---

### 2. View Guest Site Button
**Status:** 🔴 BLOCKED  
**Issue:** "View guest site" button still doesn't work after publish  
**Root Cause:**
- URL generation might be wrong
- Target route may not exist or be incorrect
- Button href may not be set properly
- New tab opening might fail

**Fix Needed:**
- Verify URL format is correct
- Test link generation
- Ensure new tab opens
- Add proper error handling

**Files to Modify:**
- wedding.html (button setup)
- guest.html (route verification)

**Test:**
- [ ] Publish a wedding
- [ ] Click "View guest site"
- [ ] Verify it opens in new tab
- [ ] Browser test that verifies link works

---

### 3. Data Persistence After Create/Navigate
**Status:** 🔴 CRITICAL  
**Issue:** After create and auto-navigate, palette, venues, and all fields must reload into edit form  
**Root Cause:**
- Auto-navigate happens too fast before data is fully saved?
- Or data isn't being saved at all to database?
- Or load function isn't fetching all fields?

**Fix Needed:**
- Verify create RPC actually saves palette, venues, registry, tiers, VIP, payout
- Verify load function fetches all these fields
- May need new migration to store venues if not currently stored
- Test full roundtrip: create → navigate → verify all fields present

**Files to Modify:**
- supabase/migrations/*.sql (if venues not stored)
- api/weddings.js (create and load)
- wedding.html (load function)

**Test:**
- [ ] Create wedding with palette, 2 venues, 1 registry item
- [ ] Auto-navigate to edit page
- [ ] Verify palette shows correctly
- [ ] Verify venues show correctly
- [ ] Verify registry shows correctly
- [ ] Reload page, all still there
- [ ] Browser test for full roundtrip

---

### 4. Payment Processor Selection (REMOVE)
**Status:** 🔴 BLOCKED  
**Issue:** Organizer must NOT choose processors. System decides from env, contributor chooses at checkout.  
**Root Cause:**
- Form currently has checkboxes for organizer to enable processors
- This is wrong - processors are determined by what's configured in env
- Organizer should only choose payout method (where to receive funds)

**Fix Needed:**
- Remove organizer payment processor checkboxes
- Organizer only selects payout method (M-Pesa, Bank, Stripe, Paystack, Other)
- Available payment methods shown to guests are determined by WEDDINGSITE_ENABLED_PAYMENT_METHODS env
- Display to organizer: "Available to guests: M-Pesa, Stripe, Paystack" (read from configured env)

**Files to Modify:**
- wedding.html (remove processor checkboxes)
- api/weddings.js (remove processor logic)

**Test:**
- [ ] Edit wedding
- [ ] No payment processor checkboxes visible
- [ ] Only payout method selector
- [ ] List of available methods shown (from env)

---

### 5. RSVP Feedback & Persistence
**Status:** 🔴 BLOCKED  
**Issue:** After guest submits RSVP, must persist, show confirmation, keep pass on screen, surface in organizer list  
**Root Cause:**
- RSVP save endpoint might not persist
- No confirmation feedback to guest
- Pass might disappear after submit
- Organizer RSVP list might not show submitted RSVPs

**Fix Needed:**
- Verify RSVP POST endpoint persists data
- Add toast confirmation after RSVP submit: "We've noted your RSVP!"
- Keep pass visible on screen after submit
- Load organizer RSVP table with submitted RSVPs
- Add same toast feedback for all saved fields (registry contribute, DJ bid, etc)

**Files to Modify:**
- guest.html (RSVP form, feedback, pass visibility)
- api/guest.js (RSVP persist endpoint)
- wedding.html (RSVP table loading)

**Test:**
- [ ] Guest submits RSVP
- [ ] Toast shows "We've noted your RSVP!"
- [ ] Pass remains visible
- [ ] Organizer sees RSVP in table
- [ ] Reload page, RSVP still there

---

### 6. QR Code Verification Page
**Status:** 🔴 BLOCKED  
**Issue:** QR code must encode URL (https://.../verify?code=...) with verification page  
**Root Cause:**
- QR code currently might not encode URL
- Verification page doesn't exist
- No check-in action for organizer

**Fix Needed:**
- Generate QR code with URL: `https://weddingsite-colyske.vercel.app/verify?code=<encrypted-guest-code>`
- Create verify.html page
- Verify page shows: guest name, RSVP status, check-in action
- Check-in action updates guest status in database

**Files to Modify:**
- ecard.html (QR generation with URL)
- Create verify.html (new verification page)
- api/guest.js (check-in endpoint)

**Test:**
- [ ] Generate QR code for guest
- [ ] Scan QR in real QR reader
- [ ] Opens verify page
- [ ] Shows guest name and status
- [ ] Can check in guest
- [ ] Status updates

---

### 7. Color Palette Confusion (Theme vs Attire)
**Status:** 🟡 NEEDS CLARIFICATION  
**Issue:** Confusion between "Wedding details" palette and "Attire & dress code" palette  
**Root Cause:**
- Currently seems to be TWO palettes?
- Or they're the same but labeled confusingly?
- Help text is unclear

**Fix Needed:**
- Option A: Use ONE theme palette for site theme; attire section says "Suggested outfit colours (same as above)"
- Option B: Keep separate palettes but clearly label "Site theme colors" vs "Suggested dress colours"
- Choose simplest: likely Option A (reuse theme palette, explain in attire section)

**Files to Modify:**
- wedding.html (attire section label and help text)

**Test:**
- [ ] Verify what the organizer sees
- [ ] Verify what the guest sees
- [ ] Make sure there's no confusion

---

### 8. Countdown on Guest Site
**Status:** 🔴 BLOCKED  
**Issue:** Countdown isn't working  
**Root Cause:**
- Wedding date might not be parsed correctly
- Timezone handling might be wrong
- JavaScript countdown logic might not be running
- "Today/started" state not handled

**Fix Needed:**
- Parse wedding date from API (format: YYYY-MM-DD or ISO)
- Calculate time remaining
- Handle "started" state (date in past or today)
- Update countdown every second
- Show readable format: "5 days, 3 hours"

**Files to Modify:**
- guest.html (countdown logic)

**Test:**
- [ ] Future wedding: shows countdown
- [ ] Today: shows "Today!"
- [ ] Past wedding: shows "Event started"
- [ ] Countdown counts down correctly (watch it update)

---

### 9. RSVPs and DJ Bids on Guest Site & Dashboard
**Status:** 🔴 BLOCKED  
**Issue:** RSVPs and DJ bids not appearing on guest site and organizer dashboard  
**Root Cause:**
- Data might not be persisting when submitted
- Guest site might not be loading them
- Dashboard might not be loading them
- Leaderboard might not be sorting correctly

**Fix Needed:**
- Verify RSVP POST endpoint saves to database
- Verify DJ bid POST endpoint saves to database
- Guest site loads RSVPs and displays count
- Guest site shows DJ bid leaderboard sorted by amount (DESC)
- Organizer dashboard shows RSVP table with submitted RSVPs
- Organizer dashboard shows bids table with submitted bids

**Files to Modify:**
- api/guest.js (ensure endpoints persist)
- guest.html (load and display RSVPs, bids)
- wedding.html (load and display organizer view)

**Test:**
- [ ] Guest submits RSVP
- [ ] Guest site shows it in count/list
- [ ] Organizer sees it in RSVP table
- [ ] Guest places DJ bid
- [ ] Guest site leaderboard shows it sorted
- [ ] Organizer sees it in bids table

---

### 10. Guest Site: VIP Seating, Sponsorships, Features
**Status:** 🔴 BLOCKED  
**Issue:** VIP seating, sponsorships, other features not rendered on guest site  
**Root Cause:**
- Guest site might not be loading these sections
- Sections might not be visible even if loaded
- They're only shown if organizer enabled them

**Fix Needed:**
- Load VIP offer if present
- Load sponsor tiers if present
- Render them on guest site only if configured
- Display: title, price, available seats, description
- Display: tier name, min amount, perks
- Only show if data is present

**Files to Modify:**
- guest.html (add VIP and tier sections)
- api/guest.js (load VIP and tiers)

**Test:**
- [ ] Organizer configures VIP
- [ ] Guest site shows VIP section
- [ ] Organizer configures tiers
- [ ] Guest site shows tier section
- [ ] Both show correct data

---

### 11. Account Menu
**Status:** 🔴 BLOCKED  
**Issue:** Account menu still doesn't open  
**Root Cause:**
- Click handler might not be working
- Menu might be hidden behind other elements (z-index)
- Menu might not have display:block on click
- Console might have errors

**Fix Needed:**
- Debug: check if click handler fires
- Debug: check CSS z-index
- Debug: check if menu div is rendered
- Fix visibility/positioning
- Test in real browser with DevTools

**Files to Modify:**
- wedding.html (account menu HTML/CSS/JS)
- dashboard.html (same fix if needed)

**Test:**
- [ ] Open DevTools Console
- [ ] Click account menu
- [ ] No JavaScript errors
- [ ] Menu appears
- [ ] Can click items
- [ ] Menu closes when clicking outside

---

### 12. Ampersand Double-Escaping
**Status:** 🔴 BLOCKED  
**Issue:** "&amp;" shows instead of "&" (double escaping)  
**Root Cause:**
- Text is HTML-escaped on server, then escaped again on client
- Or stored value is already escaped "&amp;"
- Need to find ALL places where this happens

**Fix Needed:**
- Audit every place text is output:
  - API responses: escape or send raw?
  - Database storage: raw or escaped?
  - Client display: textContent or innerHTML?
  - QR code generation: what encoding?
- Correct approach: store raw, escape only at final HTML render
- Migration: decode existing "&amp;" in database rows
- Test: "Atieno & Otieno" across dashboard, guest site, title, e-card, pass

**Files to Modify:**
- api/weddings.js (ensure raw text)
- wedding.html (use textContent where possible)
- guest.html (use textContent where possible)
- ecard.html (use textContent where possible)
- supabase/migrations/*.sql (add migration to decode)

**Test:**
- [ ] Create wedding "Atieno & Otieno"
- [ ] Dashboard shows correctly (not &amp;)
- [ ] Wedding edit page shows correctly
- [ ] Guest site shows correctly
- [ ] E-card shows correctly
- [ ] Reload page, still correct

---

## Fix Priority

Order to work in (dependencies first):

1. **Data Persistence (#3)** - Everything depends on this
2. **Palette Validation (#1)** - Basic create/edit must work
3. **Ampersand Escaping (#12)** - Affects all output
4. **Account Menu (#11)** - Navigation blocker
5. **View Guest Site (#2)** - Guest access blocker
6. **RSVPs & Bids (#9)** - Core feature
7. **RSVP Feedback (#5)** - UX
8. **Payment Processors (#4)** - Architecture fix
9. **QR Verification (#6)** - Advanced feature
10. **Countdown (#8)** - Guest site feature
11. **VIP/Sponsorships (#10)** - Guest site feature
12. **Palette Confusion (#7)** - Documentation/UX

---

## Progress

- [ ] Issue 1: Palette Validation
- [ ] Issue 2: View Guest Site Button
- [ ] Issue 3: Data Persistence
- [ ] Issue 4: Payment Processors
- [ ] Issue 5: RSVP Feedback
- [ ] Issue 6: QR Verification
- [ ] Issue 7: Palette Confusion
- [ ] Issue 8: Countdown
- [ ] Issue 9: RSVPs & Bids
- [ ] Issue 10: VIP/Sponsorships
- [ ] Issue 11: Account Menu
- [ ] Issue 12: Ampersand Escaping

---

## Testing Notes

After each fix:
1. Test in real browser on Production URL
2. Use real signed-in Owner session
3. Create new wedding or use existing test wedding
4. Verify in browser console for errors
5. Add regression test to tests/ directory
6. Document in commit message

No test should assume things work - verify every step with real data.
