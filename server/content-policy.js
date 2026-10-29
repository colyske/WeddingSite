import "../contact-policy.js";

const freeText = new Set([
  "name", "displayname", "couplenames", "guestname", "companyname", "contactname", "authorname",
  "songtitle", "artist", "artistname", "title", "description", "message", "notes", "note",
  "welcomestory", "storydraft", "story", "attirenotes", "dietarynotes", "partynames",
  "location", "publiclocation", "address", "offer", "purpose", "perks", "travel",
  "travelnotes", "travelinfo", "question", "answer", "q", "a", "label", "palettenames",
  "task", "minutes", "announcement", "content", "details", "nextofkinname", "relation", "category",
  "campaign", "milestone", "vendor", "vendorname", "tablename", "subject", "reason"
]);

export function contentError(value) {
  function visit(item, check = false) {
    if (typeof item === "string") return check && globalThis.WSContactPolicy.hasContact(item);
    if (Array.isArray(item)) return item.some(entry => visit(entry, check));
    if (!item || typeof item !== "object") return false;
    return Object.entries(item).some(([key, child]) =>
      visit(child, freeText.has(key.replace(/^p_/, "").toLowerCase().replace(/[_-]/g, ""))));
  }
  return visit(value) ? globalThis.WSContactPolicy.message : null;
}
