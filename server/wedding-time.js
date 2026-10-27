// A wedding is "past" once its calendar date (in the wedding's own time zone) is before today in that zone.
export function todayInZone(timeZone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function isPastWedding(weddingDate, timeZone = "Africa/Nairobi", now = new Date()) {
  if (!weddingDate) return false;
  return String(weddingDate).slice(0, 10) < todayInZone(timeZone, now);
}
