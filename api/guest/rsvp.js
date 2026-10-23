// POST /api/guest/rsvp
// Accept RSVP for a published wedding
// Request: { weddingId, guestName, emailAddress, dietaryNeeds, premiumDietaryOptedIn }
// Response: { rsvpId, attendanceStatus }

import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";

export default async function handler(req, res) {
  if (!methodOnly(req, res, "POST")) return;

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { weddingId, guestName, emailAddress, dietaryNeeds, premiumDietaryOptedIn = false } = body;

  if (!weddingId || !/^[0-9a-f-]{36}$/.test(weddingId) || !guestName || !emailAddress) {
    return sendJson(res, 400, { error: "Missing or invalid wedding ID, guest name, or email." });
  }

  try {
    // Call atomic capacity-checked RSVP function
    const result = await supabaseRequest(`/rest/v1/rpc/accept_rsvp_with_capacity_check`, {
      method: "POST",
      body: {
        p_wedding_id: weddingId,
        p_guest_name: guestName.trim().slice(0, 100),
        p_guest_email: emailAddress.trim().toLowerCase().slice(0, 255),
        p_dietary_needs: dietaryNeeds ? dietaryNeeds.trim().slice(0, 500) : "",
        p_premium_dietary_opted_in: premiumDietaryOptedIn
      }
    });

    if (result.error) {
      return sendJson(res, 400, { error: result.error || "Could not accept RSVP. Capacity may be full." });
    }

    return sendJson(res, 201, { rsvpId: result.rsvp_id, attendanceStatus: "yes" });
  } catch (error) {
    console.error("rsvp failed", error.message);
    return sendJson(res, 400, { error: "Could not process RSVP." });
  }
}
