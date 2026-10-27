import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";
import { isPastWedding } from "../server/wedding-time.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(["vip", "sponsor", "pledge"]);
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Test-mode payment simulator. No money moves; rows are labelled provider "test-simulator".
// Disabled automatically when WEDDINGSITE_PAYMENT_MODE=live (real providers must be used instead).
export default async function handler(req, res) {
  if (String(process.env.WEDDINGSITE_PAYMENT_MODE || "").toLowerCase() === "live") {
    return sendJson(res, 403, { error: "Test payments are disabled in live mode." });
  }
  const action = String(req.query?.action || "");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const rpc = (name, args) => supabaseRequest(`/rest/v1/rpc/${name}`, { service: true, method: "POST", body: args });

  try {
    if (action === "purchase") {
      if (!methodOnly(req, res, "POST")) return;
      const slug = text(body.slug, 80).toLowerCase();
      const kind = text(body.kind, 10);
      if (!/^[a-z0-9-]{3,80}$/.test(slug) || !KINDS.has(kind) || !UUID.test(String(body.refId || ""))) {
        return sendJson(res, 400, { error: "Choose what you would like to book or give." });
      }
      const amount = Math.round(Number(body.amount) * 100);
      if (!Number.isFinite(amount) || amount < 100 || amount > 100000000) return sendJson(res, 400, { error: "Enter a valid amount." });
      const name = text(body.name, 100);
      const email = text(body.email, 200).toLowerCase();
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: "Enter a valid email or leave it blank." });
      if (kind !== "pledge" && !name) return sendJson(res, 400, { error: "Please enter your name." });
      const weddings = await supabaseRequest(`/rest/v1/weddings?slug=eq.${encodeURIComponent(slug)}&published_at=not.is.null&archived_at=is.null&select=id,wedding_date,time_zone`, { service: true });
      if (!weddings?.length) return sendJson(res, 404, { error: "Wedding not found." });
      if (isPastWedding(weddings[0].wedding_date, weddings[0].time_zone)) {
        return sendJson(res, 410, { error: "This wedding has taken place, so contributions are closed." });
      }
      const id = await rpc("record_test_purchase", {
        p_kind: kind, p_wedding_id: weddings[0].id, p_ref: body.refId, p_name: name, p_email: email,
        p_amount_minor: amount,
        p_extra: { visibility: ["name", "anonymous", "hidden"].includes(body.visibility) ? body.visibility : "hidden",
          phone: text(body.phone, 20), website: /^https?:\/\//i.test(body.website || "") ? text(body.website, 300) : "" }
      });
      return sendJson(res, 200, { ok: true, test: true, contributionId: id, message: "Test payment recorded. No real money was moved." });
    }

    if (action === "publication") {
      if (!methodOnly(req, res, "POST")) return;
      const session = await requireAuth(req, res);
      if (!session) return;
      if (!UUID.test(String(body.weddingId || ""))) return sendJson(res, 400, { error: "Invalid wedding." });
      const own = await supabaseRequest(`/rest/v1/weddings?id=eq.${body.weddingId}&client_owner_id=eq.${encodeURIComponent(session.user.id)}&select=id`, { token: session.token });
      if (!own?.length) return sendJson(res, 404, { error: "Wedding not found." });
      const quote = await rpc("record_test_publication_payment", { p_wedding_id: body.weddingId });
      return sendJson(res, 200, { ok: true, test: true, quote, message: "Test payment recorded. No real money was moved." });
    }

    return sendJson(res, 404, { error: "Unknown action." });
  } catch (error) {
    console.error("testpay failed", action, String(error?.message || "").slice(0, 300));
    const m = String(error?.message || "");
    const safe = /sold out|below the tier|must equal|not accepting|not found|taken place/i.test(m) ? m : "The test payment could not be recorded.";
    return sendJson(res, error.status && error.status < 500 ? error.status : 503, { error: safe });
  }
}
