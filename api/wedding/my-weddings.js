import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";
import { requireAuth } from "../../server/auth-middleware.js";

// GET /api/wedding/my-weddings
// Returns list of weddings the authenticated user is a client or admin for
export default async function handler(req, res) {
  if (!methodOnly(req, res, "GET")) return;

  const session = await requireAuth(req, res);
  if (!session) return;

  try {
    // Fetch weddings where user is client or admin
    const weddings = await supabaseRequest(
      `/rest/v1/weddings?client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=id,couple_names,wedding_date,currency,published_at,created_at`,
      { token: session.token }
    );

    // Also fetch weddings where user has workspace membership
    let memberships = [];
    try {
      const memberWeddings = await supabaseRequest(
        `/rest/v1/wedding_memberships?user_id=eq.${encodeURIComponent(session.user.id)}&select=wedding_id,role`,
        { token: session.token }
      );
      memberships = memberWeddings || [];
    } catch {
      // RLS may restrict; that's okay
    }

    const memberIds = memberships.map(m => m.wedding_id);
    const combined = Array.from(
      new Map([...weddings, ...memberships].map(w => [w.id || w.wedding_id, w])).values()
    );

    return sendJson(res, 200, {
      weddings: combined.slice(0, 50), // Paginate if needed
      count: combined.length
    });
  } catch (error) {
    console.error("fetch weddings failed", error.message);
    return sendJson(res, error.status || 500, { error: "Could not fetch your weddings." });
  }
}
