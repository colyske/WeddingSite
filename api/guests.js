import { authenticatedUser, sendJson, supabaseRequest } from "../server/supabase.js";

export default async function handler(req, res) {
  const action = String(req.query.action || "");
  const weddingId = String(req.query.weddingId || "");

  if (!weddingId.match(/^[0-9a-f-]{36}$/i)) {
    return sendJson(res, 400, { error: "Invalid wedding ID." });
  }

  let session;
  try {
    session = await authenticatedUser(req);
  } catch (error) {
    console.error("guests authentication failed", error.message);
    return sendJson(res, 503, { error: "Authentication service unavailable." });
  }

  if (!session) return sendJson(res, 401, { error: "Sign in to manage guests." });

  try {
    if (action === "import") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST required." });

      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const guests = Array.isArray(body.guests) ? body.guests : [];

      if (!guests.length) {
        return sendJson(res, 400, { error: "No guests provided." });
      }

      // Verify ownership
      const wedding = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&select=id,owner_id`,
        { token: session.token }
      );

      if (!Array.isArray(wedding) || !wedding.length) {
        return sendJson(res, 404, { error: "Wedding not found." });
      }

      if (wedding[0].owner_id !== session.user.id) {
        return sendJson(res, 403, { error: "Not authorized." });
      }

      // Delete existing guests
      await supabaseRequest(
        `/rest/v1/guests?wedding_id=eq.${encodeURIComponent(weddingId)}`,
        { method: "DELETE", token: session.token }
      );

      // Insert new guests
      const importedGuests = guests.map(g => ({
        wedding_id: weddingId,
        name: String(g.name || "").trim().slice(0, 120),
        email: String(g.email || "").trim().toLowerCase().slice(0, 200),
        dietary_preference: String(g.dietary || "").trim().slice(0, 50),
        table_number: String(g.table || "").trim().slice(0, 20),
        rsvp_status: "invited",
        plus_ones: 0
      })).filter(g => g.name);

      if (!importedGuests.length) {
        return sendJson(res, 400, { error: "No valid guest records found." });
      }

      const result = await supabaseRequest(
        `/rest/v1/guests`,
        {
          method: "POST",
          token: session.token,
          body: JSON.stringify(importedGuests)
        }
      );

      if (result.code) {
        return sendJson(res, 400, { error: result.message || "Could not import guests." });
      }

      return sendJson(res, 201, {
        imported: importedGuests.length,
        guests: result || importedGuests
      });
    }

    if (action === "list") {
      // Get all guests for this wedding
      const wedding = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${encodeURIComponent(weddingId)}&select=id,owner_id`,
        { token: session.token }
      );

      if (!Array.isArray(wedding) || !wedding.length) {
        return sendJson(res, 404, { error: "Wedding not found." });
      }

      if (wedding[0].owner_id !== session.user.id) {
        return sendJson(res, 403, { error: "Not authorized." });
      }

      const guests = await supabaseRequest(
        `/rest/v1/guests?wedding_id=eq.${encodeURIComponent(weddingId)}&select=*&order=table_number,name`,
        { token: session.token }
      );

      return sendJson(res, 200, { guests: guests || [] });
    }

    if (action === "update") {
      // Update a guest record
      if (req.method !== "PATCH") return sendJson(res, 405, { error: "PATCH required." });

      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const guestId = String(body.guestId || "");
      const updates = {};

      if (body.tableNumber !== undefined) {
        updates.table_number = String(body.tableNumber || "").trim().slice(0, 20);
      }
      if (body.rsvpStatus !== undefined) {
        updates.rsvp_status = String(body.rsvpStatus || "invited").slice(0, 20);
      }
      if (body.plusOnes !== undefined) {
        const n = Number(body.plusOnes || 0);
        if (Number.isInteger(n) && n >= 0 && n <= 10) {
          updates.plus_ones = n;
        }
      }

      if (!Object.keys(updates).length) {
        return sendJson(res, 400, { error: "Nothing to update." });
      }

      // Verify ownership via wedding
      const guest = await supabaseRequest(
        `/rest/v1/guests?id=eq.${encodeURIComponent(guestId)}&select=wedding_id`,
        { token: session.token }
      );

      if (!Array.isArray(guest) || !guest.length) {
        return sendJson(res, 404, { error: "Guest not found." });
      }

      const wedding = await supabaseRequest(
        `/rest/v1/weddings?id=eq.${encodeURIComponent(guest[0].wedding_id)}&select=id,owner_id`,
        { token: session.token }
      );

      if (!wedding[0] || wedding[0].owner_id !== session.user.id) {
        return sendJson(res, 403, { error: "Not authorized." });
      }

      const result = await supabaseRequest(
        `/rest/v1/guests?id=eq.${encodeURIComponent(guestId)}`,
        {
          method: "PATCH",
          token: session.token,
          body: JSON.stringify(updates)
        }
      );

      return sendJson(res, 200, { guest: result[0] || result });
    }

    return sendJson(res, 400, { error: `Unknown action: ${action}` });
  } catch (error) {
    console.error("guests handler failed", error.message);
    return sendJson(res, 500, { error: "Guests service failed." });
  }
}
