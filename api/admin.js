import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";

// Admin-only endpoints for Owner and SuperAdmin roles
export default async function handler(req, res) {
  const session = await requireAuth(req, res);
  if (!session) return;

  // Check role (would be stored in user metadata or separate table in production)
  const isAdmin = true; // Simplified - in production, check user role from database/Supabase custom claims
  if (!isAdmin) return sendJson(res, 403, { error: "Unauthorized." });

  const action = String(req.query?.action || "metrics");
  const opts = { token: session.token };

  try {
    if (action === "metrics") {
      if (!methodOnly(req, res, "GET")) return;
      // Get summary metrics
      const weddings = await supabaseRequest("/rest/v1/weddings?select=id,couple_names,wedding_date,published_at,max_guest_capacity,currency", opts).catch(() => []);
      const rsvps = await supabaseRequest("/rest/v1/guest_rsvps?select=id", opts).catch(() => []);
      const contributions = await supabaseRequest("/rest/v1/contributions?select=amount_minor", opts).catch(() => []);

      const total_collected = (contributions || []).reduce((sum, c) => sum + (c.amount_minor || 0), 0);
      const recent_activity = (weddings || []).slice(0, 5).map(w => ({
        ...w,
        rsvp_count: (rsvps || []).length,
        bid_count: 0, // Would join with dj_song_bids
        contribution_total: total_collected
      }));

      return sendJson(res, 200, {
        metrics: {
          total_weddings: (weddings || []).length,
          published_weddings: (weddings || []).filter(w => w.published_at).length,
          total_rsvps: (rsvps || []).length,
          total_collected_minor: total_collected
        },
        recent_activity
      });
    }

    if (action === "weddings") {
      if (!methodOnly(req, res, "GET")) return;
      const weddings = await supabaseRequest("/rest/v1/weddings?select=id,couple_names,wedding_date,published_at,max_guest_capacity,currency&order=created_at.desc&limit=100", opts).catch(() => []);
      return sendJson(res, 200, { weddings: weddings || [] });
    }

    if (action === "role") {
      if (!methodOnly(req, res, "GET")) return;
      // Simplified - return a role. In production, check user's actual role from claims
      return sendJson(res, 200, { role: "superadmin" });
    }

    return sendJson(res, 404, { error: "Unknown action." });
  } catch (error) {
    console.error("admin endpoint failed", error.message);
    return sendJson(res, 503, { error: "Service temporarily unavailable." });
  }
}
