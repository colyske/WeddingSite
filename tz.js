/* Time-zone helpers shared by the guest site, organizer editor, client template and tests. No dependencies. */
(function (root) {
  "use strict";
  var DEFAULT_ZONE = "Africa/Nairobi";
  var ABBR = {
    "Africa/Nairobi": "EAT", "Africa/Kampala": "EAT", "Africa/Dar_es_Salaam": "EAT", "Africa/Addis_Ababa": "EAT",
    "Africa/Mogadishu": "EAT", "Africa/Djibouti": "EAT", "Africa/Lagos": "WAT", "Africa/Kinshasa": "WAT",
    "Africa/Johannesburg": "SAST", "Africa/Harare": "CAT", "Africa/Lusaka": "CAT", "Africa/Maputo": "CAT",
    "Africa/Kigali": "CAT", "Africa/Cairo": "EET", "Africa/Accra": "GMT", "UTC": "UTC"
  };
  var FALLBACK = ["Africa/Nairobi", "Africa/Kampala", "Africa/Dar_es_Salaam", "Africa/Kigali", "Africa/Addis_Ababa", "Africa/Lagos",
    "Africa/Accra", "Africa/Johannesburg", "Africa/Cairo", "UTC", "Europe/London", "Europe/Paris", "Asia/Dubai",
    "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];

  function validZone(tz) {
    if (typeof tz !== "string" || !tz || tz.length > 64) return false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; }
  }
  function browserZone() {
    try { var z = Intl.DateTimeFormat().resolvedOptions().timeZone; return validZone(z) ? z : DEFAULT_ZONE; } catch (e) { return DEFAULT_ZONE; }
  }
  function zoneList() {
    var all = [];
    try { if (Intl.supportedValuesOf) all = Intl.supportedValuesOf("timeZone"); } catch (e) { all = []; }
    if (!all.length) all = FALLBACK.slice();
    if (all.indexOf("UTC") < 0) all.push("UTC");
    var prominent = ["Africa/Nairobi"];
    return prominent.concat(all.filter(function (z) { return prominent.indexOf(z) < 0; }));
  }
  function offsetMs(ms, tz) {
    var p = {};
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }
  /** Wall-clock date ("YYYY-MM-DD") + time ("HH:MM[:SS]") in zone -> UTC epoch ms, or null. */
  function zonedToUtc(dateStr, timeStr, tz) {
    var d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ""));
    if (!d) return null;
    var t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(timeStr || "")) || [0, 0, 0, 0];
    var zone = validZone(tz) ? tz : DEFAULT_ZONE;
    var guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], +(t[3] || 0));
    var first = guess - offsetMs(guess, zone);
    var second = guess - offsetMs(first, zone);
    return second;
  }
  function abbreviation(tz, ms) {
    if (ABBR[tz]) return ABBR[tz];
    try {
      var part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find(function (x) { return x.type === "timeZoneName"; });
      return part ? part.value : tz;
    } catch (e) { return tz; }
  }
  /** "2:00 PM EAT" */
  function formatTime(ms, tz) {
    var time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms));
    return time + " " + abbreviation(tz, ms);
  }
  function formatDate(ms, tz) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date(ms));
  }
  function mainVenue(w) { var v = (w.venues || []).filter(function (x) { return x.kind !== "pre"; }); return v.find(function (x) { return x.is_main; }) || v[0]; }
  /** Start of the wedding as UTC epoch ms using the wedding's zone and main venue time. */
  function weddingStart(w) {
    var dateStr = String(w.wedding_date || "").slice(0, 10);
    var v = mainVenue(w);
    return zonedToUtc(dateStr, v && v.event_time, w.time_zone || DEFAULT_ZONE);
  }
  function icsStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
  function icsEscape(v) { return String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1"); }
  /** RFC 5545 calendar. DTSTART is emitted in UTC (unambiguous across zones); the zone is kept in X-WR-TIMEZONE and DESCRIPTION. */
  function buildIcs(w, now) {
    var start = weddingStart(w);
    if (start == null) return null;
    var tz = w.time_zone || DEFAULT_ZONE;
    var label = formatTime(start, tz);
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WeddingSite//EN", "CALSCALE:GREGORIAN", "X-WR-TIMEZONE:" + tz,
      "BEGIN:VEVENT", "UID:" + (w.id || w.slug || "wedding") + "@weddingsite",
      "DTSTAMP:" + icsStamp(now == null ? Date.now() : now), "DTSTART:" + icsStamp(start),
      "SUMMARY:" + icsEscape((w.couple_names || "Wedding") + "'s Wedding"),
      "LOCATION:" + icsEscape(w.public_location || ""),
      "DESCRIPTION:" + icsEscape((w.welcome_story || "Join us for our wedding!") + " (" + label + ")"),
      "END:VEVENT", "END:VCALENDAR"];
    return lines.join("\r\n");
  }
  /** Fills a <select> with Africa/Nairobi first, the browser zone second, then every IANA zone. */
  function fillSelect(select, selected) {
    var doc = select.ownerDocument, seen = {};
    select.innerHTML = "";
    var add = function (parent, z) {
      if (seen[z]) return;
      seen[z] = true;
      var o = doc.createElement("option");
      o.value = z;
      o.textContent = z.replace(/_/g, " ");
      parent.appendChild(o);
    };
    var g1 = doc.createElement("optgroup");
    g1.label = "Suggested";
    add(g1, DEFAULT_ZONE);
    add(g1, browserZone());
    select.appendChild(g1);
    var g2 = doc.createElement("optgroup");
    g2.label = "All time zones";
    zoneList().forEach(function (z) { add(g2, z); });
    select.appendChild(g2);
    var want = validZone(selected) ? selected : browserZone();
    if (!seen[want]) { var o = doc.createElement("option"); o.value = want; o.textContent = want; select.appendChild(o); }
    select.value = want;
  }
  root.WSTime = { fillSelect: fillSelect, DEFAULT_ZONE: DEFAULT_ZONE, validZone: validZone, browserZone: browserZone, zoneList: zoneList, offsetMs: offsetMs,
    zonedToUtc: zonedToUtc, formatTime: formatTime, formatDate: formatDate, abbreviation: abbreviation, weddingStart: weddingStart, buildIcs: buildIcs, icsEscape: icsEscape };
})(typeof globalThis !== "undefined" ? globalThis : window);
