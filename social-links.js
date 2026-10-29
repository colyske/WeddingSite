(function (root) {
  const platforms = {
    instagram: ["instagram.com"], facebook: ["facebook.com"],
    x: ["x.com", "twitter.com"], youtube: ["youtube.com", "youtu.be"],
    tiktok: ["tiktok.com"], linkedin: ["linkedin.com"]
  };
  const labels = { instagram: "Instagram", facebook: "Facebook", x: "X", youtube: "YouTube", tiktok: "TikTok", linkedin: "LinkedIn" };
  function parse(value) {
    if (value == null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Enter social links in their designated fields.");
    const result = {};
    for (const [platform, link] of Object.entries(value)) {
      if (!link) continue;
      if (!platforms[platform] || typeof link !== "string" || link.length > 300) throw new Error("Choose a supported social platform.");
      let url;
      try { url = new URL(link.trim()); } catch { throw new Error(`Enter a valid ${labels[platform]} HTTPS link.`); }
      const host = url.hostname.replace(/^www\./, "");
      if (url.protocol !== "https:" || url.username || url.password || url.port || !platforms[platform].includes(host) || url.pathname === "/") {
        throw new Error(`Enter a public ${labels[platform]} profile or page link on its official HTTPS domain.`);
      }
      result[platform] = url.href;
    }
    return result;
  }
  root.WSSocialLinks = Object.freeze({ parse, labels });
})(globalThis);
