import { authenticatedUser, methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";

export default async function handler(req, res) {
  if (!methodOnly(req, res, "GET")) return;
  try {
    const session = await authenticatedUser(req);
    if (!session) return sendJson(res, 401, { error: "Sign in with a valid WeddingSite account." });
    const profiles = await supabaseRequest(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(session.user.id)}&select=id,display_name,platform_role`,
      { token: session.token }
    );
    const profile = profiles?.[0];
    if (!profile) return sendJson(res, 403, { error: "This account has no WeddingSite profile. Ask an Owner to provision access." });
    return sendJson(res, 200, {
      user: { id: session.user.id, email: session.user.email || null },
      profile
    });
  } catch (error) {
    console.error("auth/me failed", error.message);
    return sendJson(res, error.status || 503, { error: "Authentication service is unavailable or misconfigured." });
  }
}
