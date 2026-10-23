export function sendJson(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function methodOnly(req, res, method) {
  res.setHeader("Allow", method);
  if (req.method !== method) {
    sendJson(res, 405, { error: "Method not allowed." });
    return false;
  }
  return true;
}

export function supabaseConfig({ service = false } = {}) {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const apiKey = service ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_ANON_KEY;
  if (!url || !apiKey) throw new Error(`Missing ${service ? "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" : "SUPABASE_URL or SUPABASE_ANON_KEY"} configuration.`);
  return { url, apiKey };
}

export async function supabaseRequest(path, { service = false, token, method = "GET", body, prefer } = {}) {
  const { url, apiKey } = supabaseConfig({ service });
  const authToken = token || apiKey;
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${authToken}`,
    Accept: "application/json"
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: "Supabase returned an invalid response." }; }
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error_description || `Supabase request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function bearerToken(req) {
  const value = req.headers.authorization || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

export async function authenticatedUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const { url, apiKey } = supabaseConfig();
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: apiKey, Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id ? { token, user } : null;
}

export function csvCell(value) {
  const valueText = String(value ?? "");
  const text = /^[=+\-@\t\r]/.test(valueText) ? `'${valueText}` : valueText;
  return `"${text.replace(/"/g, '""')}"`;
}
