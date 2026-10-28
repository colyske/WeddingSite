(function () {
  if (document.getElementById("ws-site-footer")) return;
  const f = document.createElement("footer");
  f.id = "ws-site-footer";
  f.setAttribute("role", "contentinfo");
  f.style.cssText = "text-align:center;padding:1.5rem 1rem;margin-top:2rem;font-size:.85rem;color:inherit;opacity:.8;border-top:1px solid rgba(184,146,74,.35)";
  f.textContent = "Join Our Wedding \u00B7 joinourwedding.site \u00A9 2026 \u2014 Organize your wedding your way";
  const add = () => document.body.appendChild(f);
  if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
})();
