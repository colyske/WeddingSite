#!/usr/bin/env node
/**
 * Emergency password reset tool (requires SUPABASE_SERVICE_ROLE_KEY)
 * Usage: node set-owner-password.js <password>
 * 
 * This bypasses the rate-limited email flow and directly sets the password
 * for colyske@gmail.com (the Owner account). Use only in development or
 * during initial setup when rate limits are hit.
 */

const email = "colyske@gmail.com";
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.argv[2];

if (!password || password.length < 12) {
  console.error("❌ Password must be at least 12 characters.");
  process.exit(1);
}

if (!supabaseUrl || !serviceRoleKey) {
  console.error("❌ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your environment.");
  process.exit(1);
}

(async () => {
  try {
    // 1. Find the user by email
    console.log(`🔍 Looking up user ${email}…`);
    const getUserRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!getUserRes.ok) {
      throw new Error(`GET /admin/users failed: ${getUserRes.status} ${await getUserRes.text()}`);
    }

    const users = await getUserRes.json();
    if (!users.users || users.users.length === 0) {
      throw new Error(`No user found with email ${email}`);
    }

    const user = users.users[0];
    console.log(`✓ Found user ${user.id}`);

    // 2. Update the user's password
    console.log(`🔑 Setting password…`);
    const updateRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });

    if (!updateRes.ok) {
      throw new Error(`PUT /admin/users failed: ${updateRes.status} ${await updateRes.text()}`);
    }

    console.log(`✅ Password set successfully for ${email}`);
    
    // 3. Ensure profile exists with Owner role
    console.log(`👤 Creating/updating profile with Owner role…`);
    const serviceRoleUrl = supabaseUrl.replace(/\/+$/, "");
    const profileRes = await fetch(`${serviceRoleUrl}/rest/v1/profiles`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates", // Upsert behavior
      },
      body: JSON.stringify({ id: user.id, platform_role: "Owner" }),
    });

    if (!profileRes.ok && profileRes.status !== 409) {
      console.warn(`⚠️  Could not create profile: ${profileRes.status}`);
    } else {
      console.log(`✅ Profile configured with Owner role`);
    }
    
    console.log(`\n📝 Next steps:`);
    console.log(`   1. Go to https://weddingsite-six-bice.vercel.app/signin.html`);
    console.log(`   2. Enter email: ${email}`);
    console.log(`   3. Enter your new password`);
    console.log(`   4. You should be redirected to the dashboard`);
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
})();
