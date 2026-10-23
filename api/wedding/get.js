import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";
import { requireAuth } from "../../server/auth-middleware.js";

// GET /api/wedding/:weddingId
// Fetch wedding details and client-editable content
export default async function handler(req, res) {
  if (!methodOnly(req, res, "GET")) return;

  const session = await requireAuth(req, res);
  if (!session) return;

  const weddingId = req.url.split("/").pop()?.split("?")[0];
  if (!weddingId || !/^[0-9a-f-]{36}$/.test(weddingId)) {
    return sendJson(res, 400, { error: "Invalid wedding ID." });
  }

  try {
    // Fetch wedding (RLS checks workspace access)
    const weddings = await supabaseRequest(
      `/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&select=id,couple_names,wedding_date,public_location,currency,max_guest_capacity,palette,published_at,created_at`,
      { token: session.token }
    );
    const wedding = weddings?.[0];
    if (!wedding) {
      return sendJson(res, 404, { error: "Wedding not found or you don't have access." });
    }

    // Fetch guest site content
    let content = null;
    try {
      const contents = await supabaseRequest(
        `/rest/v1/guest_site_content?wedding_id=eq.${encodeURIComponent(weddingId)}&select=*`,
        { token: session.token }
      );
      content = contents?.[0] || {};
    } catch {
      content = {}; // RLS may restrict; that's okay
    }

    // Fetch guest count
    let guestCount = 0;
    try {
      const count = await supabaseRequest(
        `/rest/v1/guest_rsvps?wedding_id=eq.${encodeURIComponent(weddingId)}&attendance_status=eq.yes&select=count()`,
        { token: session.token }
      );
      guestCount = count?.[0]?.count || 0;
    } catch {
      // Guests are anonymous; only public ledger matters
    }

    return sendJson(res, 200, {
      wedding,
      content,
      guestCount
    });
  } catch (error) {
    console.error("fetch wedding failed", error.message);
    return sendJson(res, error.status || 500, { error: "Could not fetch wedding details." });
  }
}
