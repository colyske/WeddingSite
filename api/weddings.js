// POST /api/weddings (create), GET /api/weddings (list), GET /api/weddings/:id (fetch)
import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const id = url.pathname.split("/").pop();
  const isCreatePath = url.pathname === "/api/weddings" && req.method === "POST";
  const isFetchPath = /^[0-9a-f-]{36}$/.test(id) && req.method === "GET";
  const isListPath = url.pathname === "/api/weddings" && req.method === "GET";

  const session = await requireAuth(req, res);
  if (!session) return;

  if (isCreatePath) {
    // POST /api/weddings - create new wedding
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { coupleNames, weddingDate, location, currency = "USD", maxCapacity = 150, palette = [] } = body;

    if (!coupleNames || typeof coupleNames !== "string" || coupleNames.trim().length === 0) {
      return sendJson(res, 400, { error: "Couple names are required." });
    }

    try {
      const slug = coupleNames
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 80) || "wedding";

      const result = await supabaseRequest(`/rest/v1/rpc/create_wedding`, {
        method: "POST",
        token: session.token,
        body: {
          p_slug: slug,
          p_couple_names: coupleNames.trim().slice(0, 120),
          p_wedding_date: weddingDate || null,
          p_location: location ? location.trim().slice(0, 120) : "",
          p_currency: (currency || "USD").toUpperCase(),
          p_capacity: maxCapacity || 150,
          p_palette: palette.length > 0 ? palette : ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"]
        }
      });

      return sendJson(res, 201, { weddingId: result, slug });
    } catch (error) {
      console.error("create wedding failed", error.message);
      return sendJson(res, 400, { error: "Could not create wedding." });
    }
  }

  if (isListPath) {
    // GET /api/weddings - list user's weddings
    try {
      const weddings = await supabaseRequest(
        `/rest/v1/weddings?client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=id,couple_names,wedding_date,currency,published_at,created_at`,
        { token: session.token }
      );
      return sendJson(res, 200, { weddings: weddings || [], count: (weddings || []).length });
    } catch (error) {
      console.error("list weddings failed", error.message);
      return sendJson(res, 500, { error: "Could not fetch weddings." });
    }
  }

  if (isFetchPath) {
    // GET /api/weddings/:id - fetch single wedding
    try {
      const weddings = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${encodeURIComponent(id)}&select=id,couple_names,wedding_date,public_location,currency,max_guest_capacity,palette,published_at,created_at`,
        { token: session.token }
      );
      const wedding = weddings?.[0];
      if (!wedding) {
        return sendJson(res, 404, { error: "Wedding not found." });
      }

      let content = {};
      try {
        const contents = await supabaseRequest(
          `/rest/v1/guest_site_content?wedding_id=eq.${encodeURIComponent(id)}&select=*`,
          { token: session.token }
        );
        content = contents?.[0] || {};
      } catch {}

      return sendJson(res, 200, { wedding, content });
    } catch (error) {
      console.error("fetch wedding failed", error.message);
      return sendJson(res, 500, { error: "Could not fetch wedding." });
    }
  }

  return sendJson(res, 404, { error: "Endpoint not found." });
}
