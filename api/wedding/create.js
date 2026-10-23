import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";
import { requireAuth } from "../../server/auth-middleware.js";

// POST /api/wedding/create
// Create a new wedding workspace as an authenticated Client
// Request: { coupleNames, weddingDate, location, currency, maxCapacity, palette }
// Response: { weddingId, slug }
export default async function handler(req, res) {
  if (!methodOnly(req, res, "POST")) return;

  const session = await requireAuth(req, res);
  if (!session) return;

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { coupleNames, weddingDate, location, currency = "USD", maxCapacity = 150, palette = [] } = body;

  // Validate input
  if (!coupleNames || typeof coupleNames !== "string" || coupleNames.trim().length === 0 ||
      (currency && typeof currency !== "string") || (maxCapacity && typeof maxCapacity !== "number") ||
      !Array.isArray(palette)) {
    return sendJson(res, 400, { error: "Invalid wedding details." });
  }

  try {
    // Generate slug from couple names
    const slug = coupleNames
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 80) || "wedding";

    const weddingId = await supabaseRequest(`/rest/v1/rpc/create_wedding`, {
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

    return sendJson(res, 201, { weddingId, slug });
  } catch (error) {
    console.error("create wedding failed", error.message);
    return sendJson(res, error.status || 400, { error: "Could not create wedding. Check your input and role." });
  }
}
