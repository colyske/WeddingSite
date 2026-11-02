import { createHash, randomBytes } from "node:crypto";
import { methodOnly, sendJson, supabaseRequest } from "../server/supabase.js";
import { requireAuth } from "../server/auth-middleware.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ROLES = new Set(["checkin", "usher", "coordinator", "rsvp_support", "dj"]);
const emailOk = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && value.length <= 254;
const hashToken = token => createHash("sha256").update(token).digest("hex");
function expiryOptions(body) {
  const mode = body.expiryMode ?? "event";
  if (!["event", "custom", "none"].includes(mode)) return null;
  if (mode !== "custom") {
    if (body.grantExpiresAt != null) return null;
    return { p_grant_expires_at: null, p_no_expiry: mode === "none" };
  }
  if (typeof body.grantExpiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(body.grantExpiresAt)) return null;
  const date = new Date(body.grantExpiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return { p_grant_expires_at: date.toISOString(), p_no_expiry: false };
}
const rpc = (name, body, token) => supabaseRequest(`/rest/v1/rpc/${name}`, {
  method: "POST", body, token
});

export default async function handler(req, res) {
  const action = String(req.query?.action || "");
  const session = await requireAuth(req, res);
  if (!session) return;
  const body = req.body && typeof req.body === "object" ? req.body : {};

  try {
    if (action === "manage") {
      if (!methodOnly(req, res, "GET")) return;
      const weddingId = String(req.query.weddingId || "");
      if (!UUID.test(weddingId)) return sendJson(res, 400, { error: "Invalid wedding." });
      const team = await rpc("get_wedding_team", { p_wedding_id: weddingId }, session.token);
      return sendJson(res, 200, { team });
    }

    if (action === "invite") {
      if (!methodOnly(req, res, "POST")) return;
      const weddingId = String(body.weddingId || "");
      const role = String(body.role || "");
      const inviteeEmail = String(body.email || "").trim().toLowerCase();
      const expiry = expiryOptions(body);
      if (!UUID.test(weddingId) || !ROLES.has(role) || !emailOk(inviteeEmail) || !expiry) {
        return sendJson(res, 400, { error: "Choose a valid role, helper email address, and access expiry." });
      }
      if (expiry.p_grant_expires_at && new Date(expiry.p_grant_expires_at).getTime() <= Date.now()) {
        return sendJson(res, 400, { error: "Helper access expiry must be in the future." });
      }
      const token = randomBytes(32).toString("base64url");
      const inviteId = await rpc("create_wedding_team_invite", {
        p_wedding_id: weddingId,
        p_role: role,
        p_invitee_email: inviteeEmail,
        p_token_hash: hashToken(token),
        p_expires_days: 7,
        ...expiry
      }, session.token);
      return sendJson(res, 201, {
        inviteId,
        inviteLink: `/team-invite.html?token=${encodeURIComponent(token)}`,
        delivery: "link_created_not_sent",
        expiresInDays: 7
      });
    }

    if (action === "set-expiry") {
      if (!methodOnly(req, res, "POST")) return;
      const weddingId = String(body.weddingId || "");
      const userId = String(body.userId || "");
      const expiry = expiryOptions(body);
      if (!UUID.test(weddingId) || !UUID.test(userId) || !expiry) {
        return sendJson(res, 400, { error: "Choose a valid helper and access expiry." });
      }
      await rpc("set_wedding_team_member_expiry", {
        p_wedding_id: weddingId, p_user_id: userId, ...expiry
      }, session.token);
      return sendJson(res, 200, { updated: true });
    }

    if (action === "revoke-invite" || action === "revoke-member") {
      if (!methodOnly(req, res, "POST")) return;
      const weddingId = String(body.weddingId || "");
      if (!UUID.test(weddingId)) return sendJson(res, 400, { error: "Invalid wedding." });
      if (action === "revoke-invite") {
        const inviteId = String(body.inviteId || "");
        if (!UUID.test(inviteId)) return sendJson(res, 400, { error: "Invalid invitation." });
        await rpc("revoke_wedding_team_invite", { p_wedding_id: weddingId, p_invite_id: inviteId }, session.token);
      } else {
        const userId = String(body.userId || "");
        if (!UUID.test(userId)) return sendJson(res, 400, { error: "Invalid team member." });
        await rpc("revoke_wedding_team_member", { p_wedding_id: weddingId, p_user_id: userId }, session.token);
      }
      return sendJson(res, 200, { revoked: true });
    }

    if (action === "invite-details") {
      if (!methodOnly(req, res, "GET")) return;
      const token = String(req.query.token || "");
      if (!TOKEN.test(token)) return sendJson(res, 400, { error: "Invalid invitation link." });
      const invite = await rpc("get_wedding_team_invite", { p_token_hash: hashToken(token) }, session.token);
      const detail = Array.isArray(invite) ? invite[0] : invite;
      return sendJson(res, 200, { invite: detail });
    }

    if (action === "accept") {
      if (!methodOnly(req, res, "POST")) return;
      const token = String(body.token || "");
      if (!TOKEN.test(token)) return sendJson(res, 400, { error: "Invalid invitation link." });
      const accepted = await rpc("redeem_wedding_team_invite", { p_token_hash: hashToken(token) }, session.token);
      const result = Array.isArray(accepted) ? accepted[0] : accepted;
      return sendJson(res, 200, { accepted: result });
    }

    if (action === "workspace") {
      if (!methodOnly(req, res, "GET")) return;
      const weddingId = String(req.query.weddingId || "");
      if (!UUID.test(weddingId)) return sendJson(res, 400, { error: "Invalid wedding." });
      const workspace = await rpc("get_wedding_team_workspace", { p_wedding_id: weddingId }, session.token);
      return sendJson(res, 200, { workspace });
    }

    return sendJson(res, 404, { error: "Unknown action." });
  } catch (error) {
    const message = error.message || "";
    if (/expiry|expires/i.test(message)) {
      return sendJson(res, 400, { error: message.slice(0, 240) });
    }
    if (/invitation is unavailable|email|ownership|access denied|only the couple|team member not found|invitation not found/i.test(message)) {
      return sendJson(res, 403, { error: message.slice(0, 240) });
    }
    console.error("wedding team endpoint failed", { action, message });
    return sendJson(res, error.status && error.status < 500 ? error.status : 503, {
      error: error.status && error.status < 500 ? message || "The request could not be completed." : "Wedding team service is temporarily unavailable."
    });
  }
}
