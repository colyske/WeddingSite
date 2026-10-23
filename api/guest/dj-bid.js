// POST /api/guest/dj-bid
// Place or update a DJ song bid for a published wedding
// Request: { weddingId, songTitle, artistName, bidAmountMinor, guestEmail }
// Response: { bidId, rank, totalBidAmount }

import { methodOnly, sendJson, supabaseRequest } from "../../server/supabase.js";

export default async function handler(req, res) {
  if (!methodOnly(req, res, "POST")) return;

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { weddingId, songTitle, artistName, bidAmountMinor, guestEmail } = body;

  if (!weddingId || !/^[0-9a-f-]{36}$/.test(weddingId) || !songTitle || bidAmountMinor == null || bidAmountMinor < 0) {
    return sendJson(res, 400, { error: "Invalid wedding ID, song, or bid amount." });
  }

  try {
    // Insert DJ bid
    const bids = await supabaseRequest(`/rest/v1/dj_song_bids`, {
      method: "POST",
      body: {
        wedding_id: weddingId,
        song_title: songTitle.trim().slice(0, 200),
        artist_name: artistName ? artistName.trim().slice(0, 100) : "",
        bid_amount_minor: Math.floor(bidAmountMinor),
        guest_email: guestEmail ? guestEmail.trim().toLowerCase().slice(0, 255) : ""
      }
    });

    const bid = bids?.[0];
    if (!bid) {
      return sendJson(res, 400, { error: "Could not insert DJ bid." });
    }

    // Re-rank DJ bids for this wedding
    await supabaseRequest(`/rest/v1/rpc/rank_dj_bids_for_wedding`, {
      method: "POST",
      body: { p_wedding_id: weddingId }
    });

    return sendJson(res, 201, { bidId: bid.id, rank: bid.rank_position, totalBidAmount: bid.bid_amount_minor });
  } catch (error) {
    console.error("dj bid failed", error.message);
    return sendJson(res, 400, { error: "Could not place DJ bid." });
  }
}
