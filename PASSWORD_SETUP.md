# Temporary Password Setup (Email Rate Limit Workaround)

If you're hitting Supabase's email rate limit ("email rate limit exceeded"), you can use the admin API to set your password directly without waiting for the email flow to reset.

## Option 1: Use the set-owner-password script (Recommended)

1. **Get your Supabase Service Role Key:**
   - Go to https://supabase.com → WeddingSite project → Settings → API
   - Copy the "Service Role Secret" (keep this private!)

2. **Run the password setter:**
   ```bash
   # Set environment variables (replace with your actual key)
   export SUPABASE_URL="https://lvvtgxspwvmdhqyoyqyy.supabase.co"
   export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key-here"
   
   # Run the script with your desired password (min 12 chars)
   node set-owner-password.js "YourSecurePassword123!"
   ```

3. **Sign in:**
   - Go to https://weddingsite-six-bice.vercel.app/signin.html
   - Email: `colyske@gmail.com`
   - Password: the one you just set
   - Click "Sign in"

## Option 2: Wait for email rate limit to reset

Supabase rate limits usually reset after 60 minutes. You can:
- Wait ~1 hour
- Try the password recovery flow again from the sign-in page

## Option 3: Use Supabase Dashboard directly

1. Go to https://supabase.com → WeddingSite → Auth → Users
2. Find `colyske@gmail.com`
3. Click the user → "Reset password"
4. (May also hit rate limit; if so, use Option 1)

## After Your First Sign-In

Once you're in the dashboard, you can:
- ✅ Create a test wedding
- ✅ Edit and publish it
- ✅ View as guest and test RSVP/DJ bids
- ✅ Check RSVPs and bids in the admin dashboard
- ✅ Test the full user flow end-to-end

## Troubleshooting

**Still getting "email rate limit exceeded"?**
- This means the API is rate-limiting password recovery emails
- Use Option 1 (the script) to bypass the email entirely
- Or wait for the block to reset (typically 1 hour)

**Script says "No user found"?**
- Make sure your `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are correct
- Verify you're using the WeddingSite project (not CareerBoost)
- Check https://supabase.com to confirm the project exists

**Still can't sign in after setting password?**
- Go to https://weddingsite-six-bice.vercel.app/signin.html
- Enter `colyske@gmail.com` and your password
- Click "Sign in" (not "Email me a sign-in link")
- If you see a loading message, the page may be authenticating; wait a few seconds

---

Once signed in, the platform is ready to test end-to-end!
