// Middleware for verifying authenticated session and role-based routing
// Used by server-side endpoints and can be imported by page handlers

import { supabaseRequest } from "./supabase.js";

export async function getAuthSession(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];

  if (!token) return null;

  try {
    const response = await fetch(`${process.env.SUPABASE_URL?.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      cache: "no-store"
    });
    if (!response.ok) return null;
    return { token, user: await response.json() };
  } catch {
    return null;
  }
}

export async function requireAuth(req, res) {
  const session = await getAuthSession(req);
  if (!session) {
    res.status(401).json({ error: "Authentication required. Sign in first." });
    return null;
  }
  return session;
}

export async function requireRole(req, res, requiredRoles = []) {
  const session = await requireAuth(req, res);
  if (!session) return null;

  try {
    const profiles = await supabaseRequest(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(session.user.id)}&select=platform_role`,
      { token: session.token }
    );
    const profile = profiles?.[0];
    if (!profile) {
      res.status(403).json({ error: "No WeddingSite profile. Ask an Owner to provision access." });
      return null;
    }
    if (requiredRoles.length > 0 && !requiredRoles.includes(profile.platform_role)) {
      res.status(403).json({ error: "Your role does not have permission for this action." });
      return null;
    }
    return { ...session, profile };
  } catch (error) {
    console.error("role check failed", error.message);
    res.status(503).json({ error: "Role service unavailable." });
    return null;
  }
}

// Helper: Redact Owner identity from role-specific queries
export function sanitizeRoleForClient(role, isOwner) {
  if (isOwner) return "Owner"; // Owner sees their own identity in owner-only views
  if (role === "owner") return null; // Non-owners never see Owner role
  return role;
}
