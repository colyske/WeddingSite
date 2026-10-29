(function () {
  const policy = document.createElement("script");
  policy.src = "/contact-policy.js";
  policy.onload = () => {
    const forms = document.createElement("script");
    forms.src = "/compact-forms.js";
    document.body.appendChild(forms);
  };
  document.body.appendChild(policy);
  if (document.getElementById("ws-site-footer")) return;
  const f = document.createElement("footer");
  f.id = "ws-site-footer";
  f.setAttribute("role", "contentinfo");
  f.style.cssText = "text-align:center;padding:1.5rem 1rem;margin-top:2rem;font-size:.85rem;color:inherit;opacity:.8;border-top:1px solid rgba(184,146,74,.35)";
  f.appendChild(document.createTextNode("Join Our Wedding \u00B7 joinourwedding.site \u00A9 2026 \u2014 Organize your wedding your way"));
  const onWedding = /^[a-z0-9-]+\.joinourwedding\.site$/i.test(location.hostname) && !/^www\./i.test(location.hostname);
  const href = path => (window.WSSite && window.WSSite.platformUrl) ? window.WSSite.platformUrl(path) : (onWedding ? "https://joinourwedding.site" + path : path);
  const links = document.createElement("div");
  links.style.marginTop = ".35rem";
  [["Privacy Policy", "/privacy.html"], ["Terms of Service", "/terms.html"]].forEach(([label, path], i) => {
    if (i) links.appendChild(document.createTextNode(" \u00B7 "));
    const a = document.createElement("a");
    a.href = href(path);
    a.textContent = label;
    a.style.color = "inherit";
    links.appendChild(a);
  });
  f.appendChild(links);
  const add = () => document.body.appendChild(f);
  if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
})();
