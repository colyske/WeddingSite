// Host-based routing helpers for https://<couple-slug>.<base-domain> wedding sites.
// The root (and www) host serves the platform; every other non-reserved label is a wedding slug.

export const RESERVED_LABELS = new Set([
  "www", "api", "app", "admin", "owner", "auth", "login", "signin", "signup", "account", "dashboard",
  "mail", "email", "smtp", "static", "cdn", "assets", "status", "docs", "help", "support", "blog",
  "billing", "pay", "payments", "checkout", "webhooks", "staging", "preview", "dev", "test", "demo-admin"
]);

const SLUG = /^[a-z0-9-]{3,80}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function weddingBaseDomain(env = process.env) {
  const value = String(env.WEDDINGSITE_WEDDING_BASE_DOMAIN || "").trim().toLowerCase();
  return DOMAIN.test(value) ? value : "";
}

export const isReservedLabel = label => RESERVED_LABELS.has(String(label || "").toLowerCase());

// A slug can be a DNS label: 3-63 chars, a-z/0-9/hyphen, not starting or ending with a hyphen.
export const isSubdomainSlug = slug => /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(String(slug || "")) && !isReservedLabel(slug);

export function normalizeHost(host) {
  return String(host || "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

// Returns { kind: "root" | "wedding" | "reserved" | "other", slug? } for a request host.
export function classifyHost(host, base = weddingBaseDomain()) {
  const name = normalizeHost(host);
  if (!base || !name) return { kind: "other" };
  if (name === base || name === `www.${base}`) return { kind: "root" };
  if (!name.endsWith(`.${base}`)) return { kind: "other" };
  const label = name.slice(0, -(base.length + 1));
  if (label.includes(".")) return { kind: "other" };
  if (isReservedLabel(label)) return { kind: "reserved", slug: label };
  if (!isSubdomainSlug(label)) return { kind: "other" };
  return { kind: "wedding", slug: label };
}

export function canonicalWeddingUrl(slug, { base = weddingBaseDomain(), fallbackOrigin = "", params } = {}) {
  const clean = String(slug || "").toLowerCase();
  let url;
  if (base && isSubdomainSlug(clean)) url = new URL(`https://${clean}.${base}/`);
  else {
    url = new URL("/guest.html", fallbackOrigin || "https://localhost");
    url.searchParams.set("slug", clean);
  }
  for (const [key, value] of Object.entries(params || {})) if (value) url.searchParams.set(key, value);
  return url.toString();
}

export function platformOrigin(env = process.env) {
  const configured = String(env.WEDDINGSITE_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  return /^https:\/\//.test(configured) ? configured : "";
}

// Exact platform origins accepted for authenticated / payment-starting requests:
// the configured public origin plus comma-separated legacy origins kept during migration.
export function platformOrigins(env = process.env) {
  const list = [platformOrigin(env), ...String(env.WEDDINGSITE_LEGACY_ORIGINS || "").split(",")]
    .map(item => item.trim().replace(/\/+$/, ""))
    .filter(item => {
      try { const url = new URL(item); return url.origin === item && (url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname)); }
      catch { return false; }
    });
  return [...new Set(list)];
}

// A wedding-subdomain origin is only valid for that wedding's own slug.
export function weddingOriginSlug(origin, base = weddingBaseDomain()) {
  try {
    const url = new URL(String(origin || ""));
    if (url.protocol !== "https:" || url.port || url.origin !== origin) return "";
    const host = classifyHost(url.hostname, base);
    return host.kind === "wedding" ? host.slug : "";
  } catch { return ""; }
}
