# WeddingSite - End-to-End Testing Checklist

**Branch**: colyske-wedlink-wedding-platform (41 commits ahead of main)  
**Status**: Ready for Preview testing (CI in_progress, Preview deployment Ready)  
**Test Date**: October 25, 2026  
**Tester**: Real browser verification needed

---

## COMPREHENSIVE END-TO-END TEST MATRIX

### 1. AUTHENTICATION & SIGN-UP

#### 1.1 Self-Service Registration
**Test Steps**:
1. Go to `https://weddingsite-six-bice.vercel.app/signin.html`
2. Click "Create account" toggle
3. Register: email, password (12+ chars), confirm password
4. Verify: New account created, Client role assigned, redirects to dashboard
5. Verify: Email verification flow (per Supabase Auth)
6. Check: Form validation (missing fields, password mismatch)

**Expected**: ✓ New users can self-register without invitation

#### 1.2 Sign-In Flow
**Test Steps**:
1. Sign in with registered email/password
2. Verify session persists (stored in sessionStorage)
3. Check navbar shows user account menu
4. Verify "Sign out" button works

**Expected**: ✓ Authentication works, session maintained

#### 1.3 Role-Based Navigation
**Test Steps**:
1. Sign in as Client user
2. Click account menu (top right)
3. Verify menu shows: Dashboard, Account Settings, Logout
4. Verify "Admin Dashboard" link NOT present (Client role)
5. Sign in as Admin/SuperAdmin (if test account available)
6. Verify Admin Dashboard link appears
7. Verify Owner (Colin) never shown in role lists

**Expected**: ✓ Menu is role-aware, Owner invisible

---

### 2. WEDDING CREATION & EDITING

#### 2.1 Create Wedding
**Test Steps**:
1. From dashboard, fill wedding form:
   - Couple names: "Test & Wedding"
   - Date: 15/12/2026
   - Location: "Test City"
   - Currency: KES
   - Max guests: 100
   - Colors: Use default or customize
2. Click "✨ Create wedding"
3. Verify: Wedding created, form resets, wedding appears in "My Weddings"

**Expected**: ✓ Wedding created successfully, list updated

**Bug Check**: Form shouldn't reset without clear success message

#### 2.2 Mandatory Field Validation
**Test Steps**:
1. Try to submit form with empty "Couple names" field
2. Check console for validation error
3. Verify asterisks (*) on required fields
4. Verify form values preserved on error
5. Verify aria-required="true" in HTML

**Expected**: ✓ Validation works, errors shown, form preserved

#### 2.3 Edit Wedding After Creation
**Test Steps**:
1. Click created wedding
2. Edit fields:
   - Change couple names to "Test & Update"
   - Change colors
   - Add/edit venues
   - Update story
3. Save changes
4. Verify: Changes persisted to database
5. Verify: Changes visible on guest site immediately

**Expected**: ✓ All fields editable, changes persist

**Bug Check**: Fields shouldn't be disabled, save should work

#### 2.4 Special Character Handling
**Test Steps**:
1. Create wedding with couple names: "Atieno & Otieno"
2. Check display on dashboard
3. Check display on wedding editor
4. Download .ics file, check content
5. Check guest site display
6. Verify ampersand displays as "&", not "&amp;"

**Expected**: ✓ No double-escaping, special chars handled correctly

---

### 3. VENUES & ITINERARY

#### 3.1 Add Multiple Venues
**Test Steps**:
1. In wedding editor, click "+ Add venue"
2. Add 3 venues:
   - Church: 10:00 AM
   - Reception: 1:00 PM
   - After party: 9:00 PM
3. Set one as "main venue" (checkbox)
4. Add map links, descriptions
5. Save changes
6. View guest site
7. Verify all venues display correctly

**Expected**: ✓ Multiple venues work, main venue highlighted

#### 3.2 Venue Editing
**Test Steps**:
1. Edit existing venue (change time, location)
2. Save changes
3. Verify guest site updates

**Expected**: ✓ Venue edits persist

---

### 4. COLORS & ATTIRE PALETTE

#### 4.1 Color Palette Editor
**Test Steps**:
1. In wedding editor, click "🎨 Edit colours"
2. Verify 4 color inputs appear
3. Change colors using color picker
4. Change hex input directly (e.g., "#ff0000")
5. Add/remove colors (max 4)
6. Click "Apply palette"
7. View guest site
8. Verify colors applied throughout

**Expected**: ✓ Color editing works, up to 4 colors supported

#### 4.2 Attire Notes
**Test Steps**:
1. Edit attire notes: "Forest Green & Gold, formal elegance"
2. Save
3. View guest site
4. Verify attire section shows correctly

**Expected**: ✓ Attire text persists and displays

---

### 5. STORY & NARRATIVE

#### 5.1 Story Editor with AI
**Test Steps**:
1. Click "✨ Get AI suggestions"
2. Verify 5 suggestions appear
3. Click one suggestion
4. Verify story text populates
5. Edit story manually
6. Save changes
7. View guest site
8. Verify story displays with correct formatting

**Expected**: ✓ AI suggestions work, story persists

---

### 6. REGISTRY & CROWDFUNDING

#### 6.1 Add Registry Items
**Test Steps**:
1. Click "+ Add item" in Registry section
2. Add item: Honeymoon trip
   - Category: Travel
   - Target: 100,000 KES
   - Description: Beach resort week
3. Add 2-3 more items
4. Save changes
5. View guest site
6. Verify items display with progress bars

**Expected**: ✓ Registry items persist, display correctly

#### 6.2 Currency Display
**Test Steps**:
1. On guest site, check registry amounts
2. Verify format: "KES 100,000 (USD ~1,235)"
3. Open browser DevTools Network tab
4. Check if FX rates fetched
5. Refresh and verify rates cached (36-hour TTL)

**Expected**: ✓ Multi-currency display working, FX live

---

### 7. SPONSORSHIP TIERS & VIP SEATING

#### 7.1 Add Sponsorship Tiers
**Test Steps**:
1. Click "+ Add tier" in Sponsorships
2. Add tiers:
   - Gold: 50,000 KES, "Listed as Gold Sponsor"
   - Silver: 25,000 KES, "Listed as Silver Sponsor"
3. Save
4. View guest site
5. Verify tiers display with pricing and perks

**Expected**: ✓ Tiers persist, display correctly

#### 7.2 VIP Seating
**Test Steps**:
1. Set VIP title, price (e.g., 5,000 KES), seats (20)
2. Save
3. View guest site
4. Verify VIP section shows with price and availability

**Expected**: ✓ VIP offer displays

---

### 8. PUBLICATION & GUEST SITE ACCESS

#### 8.1 Publish Wedding
**Test Steps**:
1. Click "Publish wedding site"
2. Review publication fee (e.g., 5% of registry target)
3. Verify payment method selection (only configured methods shown)
4. Complete test payment (if Stripe/Paystack configured)
5. Verify wedding status changes to "Published"
6. Verify "View guest site" button appears

**Expected**: ✓ Publication flow works, fee deducted, status updated

#### 8.2 View Guest Site Button
**Test Steps**:
1. After publishing, locate "View guest site" button
2. Click it
3. Verify opens in new tab
4. Verify URL format: `/guest.html?slug=test-wedding`
5. Verify all wedding content displays

**Expected**: ✓ Button works, opens correct guest site

#### 8.3 Guest Site Appearance
**Test Steps**:
1. On guest site, verify all sections present:
   - Sticky navbar with couple monogram ✓
   - Hero with live countdown ✓
   - Story section ✓
   - Venues with maps ✓
   - Attire palette ✓
   - Registry items ✓
   - Sponsorship tiers ✓
   - RSVP section ✓
   - DJ bidding section ✓
   - Contribution ledger ✓
   - QR e-card pass ✓
2. Verify responsive layout (mobile, tablet, desktop)
3. Verify all links/buttons functional

**Expected**: ✓ All sections present and working

---

### 9. RSVP & GUEST INTERACTIONS

#### 9.1 RSVP Form
**Test Steps**:
1. On guest site, scroll to RSVP
2. Fill form:
   - Name: "Test Guest"
   - Email: test@example.com
   - Attendance: "Yes"
   - Dietary needs: "Vegetarian"
3. Submit
4. Verify: Success message, QR code appears
5. Download/view QR code
6. Check organizer sees RSVP in dashboard

**Expected**: ✓ RSVP works, QR generates, capacity enforced

#### 9.2 Capacity Enforcement
**Test Steps**:
1. Create wedding with max capacity 5
2. Submit 5 RSVPs
3. Try to submit 6th RSVP
4. Verify: Error message "Max capacity reached"

**Expected**: ✓ Capacity enforcement working

#### 9.3 QR E-Card
**Test Steps**:
1. After RSVP, QR code displays
2. Download QR code image
3. Scan QR (use phone or QR app)
4. Verify QR contains: couple names, date, guest name, location
5. Verify QR is unique per guest

**Expected**: ✓ QR generation working, unique per guest

---

### 10. DJ BIDDING LEADERBOARD

#### 10.1 Place DJ Bids
**Test Steps**:
1. On guest site, scroll to DJ section
2. Submit bid:
   - Song: "Levitating"
   - Artist: "Dua Lipa"
   - Bid amount: 1,000 KES
3. Submit bid 2: 5,000 KES for another song
4. Verify leaderboard updates, sorted by amount (highest first)
5. Check organizer sees bids in dashboard

**Expected**: ✓ Bids accepted, leaderboard sorted correctly

#### 10.2 Bid Validation
**Test Steps**:
1. Try to submit bid with 0 or negative amount
2. Verify error shown

**Expected**: ✓ Validation prevents invalid bids

---

### 11. PAYMENTS & CONTRIBUTIONS

#### 11.1 Registry Contribution
**Test Steps**:
1. On guest site, click "Contribute" on registry item
2. Enter amount (10,000 KES)
3. Select payment method (Stripe or Paystack if configured)
4. Complete test payment
5. Verify: Success message, contribution recorded
6. Check ledger shows contribution

**Expected**: ✓ Payment flow works (test mode), ledger updates

#### 11.2 Contribution Ledger
**Test Steps**:
1. Scroll to "Contributions" section
2. Verify paginated list showing:
   - Guest name
   - Contribution amount
   - Payment method
   - Date
3. Verify sorting/pagination works

**Expected**: ✓ Ledger displays all contributions correctly

---

### 12. DASHBOARD & ADMIN CONTROLS

#### 12.1 Organizer Dashboard
**Test Steps**:
1. Go to `/dashboard.html`
2. Verify "My Weddings" shows all created weddings
3. For published wedding, verify sections appear:
   - RSVPs table with guest responses
   - DJ bids leaderboard
   - Withdrawals section
4. Check filters/sorting work

**Expected**: ✓ Dashboard shows live data

#### 12.2 Admin Dashboard (if role=admin/superadmin)
**Test Steps**:
1. Sign in as admin
2. Click account menu → "Admin Dashboard"
3. Verify tabs: Metrics, Weddings, Fees, Withdrawals
4. Check metrics show platform totals
5. Verify fee configuration works (set fee, applies to all new weddings)

**Expected**: ✓ Admin controls accessible, functional

---

### 13. MANDATORY FIELDS & VALIDATION

#### 13.1 Required Field Marking
**Test Steps**:
1. On wedding editor, look for asterisks (*)
2. Verify on: Couple names, Location (minimum)
3. Inspect HTML: verify aria-required="true"
4. Try submitting with missing couple names
5. Verify error message shown

**Expected**: ✓ Mandatory fields clearly marked, validation enforced

---

### 14. COUPLE-SLUG URL ROUTING

#### 14.1 Slug Assignment
**Test Steps**:
1. Create wedding with couple names "Sarah & John"
2. Check auto-generated slug (should be "sarah-john")
3. In wedding editor, locate "Wedding web address" field
4. Verify slug appears and is editable

**Expected**: ✓ Slug auto-generated, editable

#### 14.2 Slug Validation
**Test Steps**:
1. Try to edit slug to invalid value: "Sarah & John" (has spaces, uppercase)
2. Verify validation error
3. Try reserved word: "admin"
4. Verify rejected
5. Set valid slug: "sarah-and-john"
6. Save
7. Access guest site via new slug URL

**Expected**: ✓ Validation prevents invalid slugs, unique slugs enforced

---

### 15. BROWSER CONSOLE & NETWORK

#### 15.1 Console Errors
**Test Steps**:
1. Open DevTools (F12 → Console tab)
2. Reload page
3. Check for JavaScript errors
4. Check for CORS errors
5. Check for 404s (missing resources)

**Expected**: ✓ No errors or expected errors only (e.g., 401 for unauthenticated routes)

#### 15.2 Network Performance
**Test Steps**:
1. DevTools → Network tab
2. Load guest site
3. Check all requests succeed (status 200)
4. Note any slow resources (>1 second)
5. Check API calls return data

**Expected**: ✓ All resources load, no failed requests

---

## ISSUES TO LOG

If any of the above fails, document:
1. Exact steps to reproduce
2. Expected vs actual behavior
3. Browser console error (if any)
4. Network failure (if any)
5. Screenshot or video

---

## SUMMARY VERIFICATION CHECKLIST

- [ ] Sign-up works, new account created
- [ ] Sign-in works, session maintained
- [ ] Role-based navigation working
- [ ] Wedding creation works (form submits)
- [ ] Mandatory fields validated
- [ ] Ampersand displays correctly (not &amp;)
- [ ] Wedding editing works (edit after create)
- [ ] Venues: add/edit multiple, main venue set
- [ ] Colors: edit up to 4, apply to guest site
- [ ] Story: AI suggestions, text persists
- [ ] Registry: items add, display with currency
- [ ] Sponsorship tiers: display with perks
- [ ] VIP seating: price/seats display
- [ ] Publish flow: fee payment, status update
- [ ] View guest site button: works after publish
- [ ] Guest site: all sections present, styled correctly
- [ ] RSVP form: accepts input, shows QR
- [ ] Capacity enforcement: prevents overbooking
- [ ] DJ bids: accept bids, leaderboard updates
- [ ] Contributions: payment flow works, ledger shows
- [ ] Dashboard: shows live RSVP/bid/withdrawal data
- [ ] Admin dashboard: accessible, controls work
- [ ] Slug: auto-generated, editable, validated, URL works
- [ ] Console: no JavaScript errors
- [ ] Network: all requests succeed

---

## NEXT STEPS AFTER TESTING

1. **Document Results**: For each test above, mark ✓ (pass) or ✗ (fail + issue)
2. **Log Bugs**: Create GitHub issues for any failures
3. **Create PR**: With all 41 commits once verified
4. **Provide Matrix**: Honest "implemented vs verified" breakdown to user
5. **Ask for Approval**: Before merging to main

---

**Status**: Ready for manual browser testing. Real user interaction verification needed before PR creation.
