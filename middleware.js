// Vercel Routing Middleware: serves https://<slug>.joinourwedding.site/ through the
// server-rendered wedding page. Needed because static index.html wins over vercel.json
// rewrites for "/". Root and www hosts pass through to the static platform homepage.
export const config = { matcher: "/" };

const BASE = "joinourwedding.site";

export default function middleware(request) {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(`.${BASE}`) || host === `www.${BASE}`) return undefined;
  const label = host.slice(0, -(BASE.length + 1));
  if (!label || label.includes(".")) return undefined;
  const destination = new URL("/api/guest", url);
  destination.searchParams.set("action", "page");
  return new Response(null, { headers: { "x-middleware-rewrite": destination.toString() } });
}
