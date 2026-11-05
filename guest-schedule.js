/* Scheduled status only: this does not detect attendance or actual event progress. */
(function (root) {
  "use strict";
  function date(value) {
    const text = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const ms = Date.parse(text + "T00:00:00Z");
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text ? text : null;
  }
  function localDate(ms, zone) {
    const parts = {};
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(ms).forEach(part => { parts[part.type] = part.value; });
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function instant(day, time, zone) {
    if (!day || !/^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(String(time || ""))) return null;
    const ms = root.WSTime.zonedToUtc(day, time, zone);
    const [hour, minute, second = "0"] = time.split(":");
    const wall = new Date(ms + root.WSTime.offsetMs(ms, zone));
    // Reject invalid calendar values and nonexistent local times, rather than normalizing them.
    return localDate(ms, zone) === day && wall.getUTCHours() === +hour &&
      wall.getUTCMinutes() === +minute && wall.getUTCSeconds() === Math.floor(+second) ? ms : null;
  }
  function timeline(wedding) {
    const zone = wedding.time_zone || root.WSTime.DEFAULT_ZONE;
    if (!root.WSTime.validZone(zone)) return [];
    const entries = (wedding.venues || []).map(venue => {
      const day = date(venue.event_date || (venue.kind !== "pre" ? wedding.wedding_date : null));
      const start = instant(day, venue.event_time, zone);
      const nextDay = day && new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
      const boundary = nextDay && root.WSTime.zonedToUtc(nextDay, "00:00", zone);
      // The current public venue model has no end field; accept an explicit end when supplied.
      const hasEnd = venue.event_end_time != null && venue.event_end_time !== "";
      const explicitEnd = hasEnd ? instant(day, venue.event_end_time, zone) : null;
      return { day, start, boundary, hasEnd, explicitEnd, end: null };
    });
    for (const entry of entries) {
      if (entry.start == null) continue;
      if (entry.hasEnd) {
        entry.end = entry.explicitEnd > entry.start ? Math.min(entry.explicitEnd, entry.boundary) : null;
      } else {
        // Equal starts share an interval; never sort or mutate the stored venue list.
        entry.end = entries.reduce((end, other) =>
          other.start > entry.start && other.day === entry.day ? Math.min(end, other.start) : end, entry.boundary);
      }
    }
    return entries;
  }
  function states(wedding, now = Date.now(), entries = timeline(wedding)) {
    const zone = wedding.time_zone || root.WSTime.DEFAULT_ZONE;
    if (!root.WSTime.validZone(zone)) return (wedding.venues || []).map(() => "unknown");
    const today = localDate(now, zone);
    return entries.map(entry => {
      if (!entry.day) return "unknown";
      if (entry.day < today) return "completed";
      if (entry.start == null) return "unknown";
      if (now < entry.start) return "upcoming";
      if (entry.end == null) return "unknown";
      return now < entry.end ? "current" : "completed";
    });
  }
  function mount(wedding, doc = root.document, win = root) {
    const entries = timeline(wedding);
    const rows = [...doc.querySelectorAll("[data-schedule-index]")];
    let timer = null;
    function pause() { win.clearTimeout(timer); timer = null; }
    function refresh() {
      pause();
      const now = Date.now();
      const current = states(wedding, now, entries);
      for (const row of rows) {
        const status = current[Number(row.dataset.scheduleIndex)];
        const badge = row.querySelector(".schedule-status");
        row.classList.toggle("schedule-current", status === "current");
        row.classList.toggle("schedule-completed", status === "completed");
        if (status === "current") row.setAttribute("aria-current", "time");
        else row.removeAttribute("aria-current");
        const label = status === "current" ? "Current in schedule" : status === "completed" ? "Completed" : "";
        if (badge.textContent !== label) badge.textContent = label;
        badge.hidden = !label;
      }
      if (!doc.hidden) {
        const next = entries.flatMap(entry => [entry.start, entry.end, entry.boundary])
          .filter(ms => ms != null && ms > now);
        timer = win.setTimeout(refresh, Math.max(1, Math.min(30000, ...next.map(ms => ms - now))));
      }
    }
    function visibility() { if (doc.hidden) pause(); else refresh(); }
    function pagehide(event) { if (event.persisted) pause(); else dispose(); }
    function dispose() {
      pause();
      doc.removeEventListener("visibilitychange", visibility);
      win.removeEventListener("pageshow", refresh);
      win.removeEventListener("pagehide", pagehide);
    }
    doc.addEventListener("visibilitychange", visibility);
    win.addEventListener("pageshow", refresh);
    win.addEventListener("pagehide", pagehide);
    refresh();
    return dispose;
  }
  root.WSSchedule = { date, instant, timeline, states, mount };
})(typeof globalThis !== "undefined" ? globalThis : window);
