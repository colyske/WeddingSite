/* Canonical Join Our Wedding addresses: wedding sites live at https://<slug>.joinourwedding.site/,
   the platform (sign-in, dashboard, account) lives on https://joinourwedding.site/. */
(function (root) {
  "use strict";
  var BASE = "joinourwedding.site";
  var ROOT_ORIGIN = "https://" + BASE;
  var RESERVED = ["www", "api", "app", "admin", "owner", "auth", "login", "signin", "signup", "account", "dashboard",
    "mail", "email", "smtp", "static", "cdn", "assets", "status", "docs", "help", "support", "blog",
    "billing", "pay", "payments", "checkout", "webhooks", "staging", "preview", "dev", "test", "demo-admin"];
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

  function isSubdomainSlug(slug) {
    slug = String(slug || "");
    return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(slug) && RESERVED.indexOf(slug) < 0;
  }
  function slugFromHost(host) {
    host = String(host == null ? root.location.hostname : host).toLowerCase();
    if (host.slice(-(BASE.length + 1)) !== "." + BASE) return "";
    var label = host.slice(0, -(BASE.length + 1));
    return label.indexOf(".") < 0 && isSubdomainSlug(label) ? label : "";
  }
  function onWeddingHost() { return Boolean(slugFromHost()); }
  function currentSlug() {
    return (new URLSearchParams(root.location.search).get("slug") || slugFromHost() || "").toLowerCase();
  }
  // Local development keeps same-origin /guest.html links so the local server is exercised.
  function weddingUrl(slug, params, opts) {
    slug = String(slug || "").toLowerCase();
    var hostname = (opts && opts.hostname) || root.location.hostname;
    var url;
    if (isSubdomainSlug(slug) && !LOCAL.test(hostname)) url = new URL("https://" + slug + "." + BASE + "/");
    else { url = new URL("/guest.html", (opts && opts.origin) || root.location.origin); url.searchParams.set("slug", slug); }
    Object.keys(params || {}).forEach(function (k) { if (params[k]) url.searchParams.set(k, params[k]); });
    return url.toString();
  }
  // Account/OAuth pages always live on the platform root so tokens never live on a wedding subdomain.
  function platformUrl(path) {
    path = path || "/";
    return onWeddingHost() ? ROOT_ORIGIN + path : path;
  }
  root.WSSite = {
    BASE: BASE, ROOT_ORIGIN: ROOT_ORIGIN, BRAND: "Join Our Wedding",
    isSubdomainSlug: isSubdomainSlug, slugFromHost: slugFromHost, onWeddingHost: onWeddingHost,
    currentSlug: currentSlug, weddingUrl: weddingUrl, platformUrl: platformUrl
  };
  if (onWeddingHost()) {
    document.addEventListener("DOMContentLoaded", function () {
      document.querySelectorAll("a[data-platform-link]").forEach(function (a) {
        a.href = platformUrl(a.getAttribute("href"));
      });
    });
  }
})(window);
