const demoUpdatesKey = "weddingsite-demo-approved-site-copy";
let approvedPreviewUpdates = [];
let publicPreviewReadError = false;
try {
  const savedUpdates = JSON.parse(localStorage.getItem(demoUpdatesKey) || "[]");
  if (!Array.isArray(savedUpdates)) throw new Error("Invalid demo site updates.");
  approvedPreviewUpdates = savedUpdates.filter(update => update && update.tenant === "amara");
} catch {
  publicPreviewReadError = true;
}
const latestSiteConfig = [...approvedPreviewUpdates].reverse().find(update => update.siteConfig)?.siteConfig;
const configuredEventDate = latestSiteConfig && /^\d{4}-\d{2}-\d{2}$/.test(latestSiteConfig.date)
  ? new Date(`${latestSiteConfig.date}T12:00:00`) : null;
const validSiteConfig = latestSiteConfig &&
  typeof latestSiteConfig.couple === "string" && latestSiteConfig.couple.trim().length > 0 && latestSiteConfig.couple.length <= 100 &&
  typeof latestSiteConfig.location === "string" && latestSiteConfig.location.trim().length > 0 && latestSiteConfig.location.length <= 80 &&
  configuredEventDate && !Number.isNaN(configuredEventDate.getTime()) &&
  configuredEventDate.toISOString().slice(0, 10) === latestSiteConfig.date &&
  (latestSiteConfig.story === undefined || (typeof latestSiteConfig.story === "string" && latestSiteConfig.story.length <= 500))
    ? latestSiteConfig : null;
const wedding = {
  couple: validSiteConfig?.couple || "Amara Njeri & Kito Mwangi",
  date: `${validSiteConfig?.date || "2026-12-12"}T10:00:00+03:00`,
  venue: validSiteConfig?.location || "Nairobi, Kenya"
};
const weddingSettingsKey = "weddingsite-demo-wedding-settings";
const defaultWeddingSettings = {
  currency: "USD",
  capacity: 150,
  confirmedGuests: 84,
  dietaryCostUsd: 35,
  palette: ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"],
  streams: [
    { name: "Home fund", purpose: "Build our first home together", goalUsd: 10000, raisedUsd: 6200 },
    { name: "Honeymoon", purpose: "A restful first trip together", goalUsd: 4000, raisedUsd: 0 },
    { name: "Community table", purpose: "Make room for family and friends", goalUsd: 2500, raisedUsd: 0 }
  ]
};
let weddingSettings = defaultWeddingSettings;
try {
  const settingRecord = JSON.parse(localStorage.getItem(weddingSettingsKey) || "null");
  const storedSettings = settingRecord?.tenants?.amara || settingRecord;
  if (storedSettings && window.WeddingSiteFX.options.includes(storedSettings.currency) &&
      Number.isInteger(storedSettings.capacity) && storedSettings.capacity > 0 &&
      Number.isFinite(storedSettings.dietaryCostUsd) && storedSettings.dietaryCostUsd >= 0 &&
      Array.isArray(storedSettings.palette) && storedSettings.palette.length > 0 && storedSettings.palette.length <= 4 &&
      storedSettings.palette.every(color => /^#[0-9a-f]{6}$/i.test(color)) &&
      Array.isArray(storedSettings.streams) && storedSettings.streams.length > 0 &&
      storedSettings.streams.every(stream => typeof stream.name === "string" && typeof stream.purpose === "string" && Number.isFinite(stream.goalUsd) && stream.goalUsd > 0)) {
    weddingSettings = { ...defaultWeddingSettings, ...storedSettings };
  }
} catch {
  publicPreviewReadError = true;
}
window.WeddingSiteFX.choose(weddingSettings.currency);
let demoMarketLabel = "Global · English (US)";
try {
  const feeConfig = JSON.parse(localStorage.getItem("weddingsite-demo-fee-config") || "null");
  if (feeConfig && typeof feeConfig.market === "string") demoMarketLabel = feeConfig.market;
} catch {
  publicPreviewReadError = true;
}

const toast = document.querySelector("#toast");
let toastTimeout;
function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 3700);
}
function escapeText(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function applyApprovedWeddingDetails() {
  const event = new Date(wedding.date);
  const formattedDate = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(event);
  const couple = wedding.couple;
  const initials = couple.split("&").map(name => name.trim().split(/\s+/)[0]?.[0] || "").join("&");
  document.querySelector("#header-couple").textContent = couple;
  document.querySelector("#footer-couple").textContent = couple;
  document.querySelector("#hero-couple").textContent = couple;
  document.querySelector("#header-monogram").textContent = initials;
  document.querySelector("#footer-monogram").textContent = initials;
  document.querySelector("#announcement-date").textContent = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(event);
  document.querySelector("#hero-event-date").textContent = formattedDate.toUpperCase();
  document.querySelector("#hero-event-location").textContent = wedding.venue.toUpperCase();
  document.querySelector("#story-couple-short").textContent = couple.toUpperCase();
  document.querySelector("#story-city").textContent = wedding.venue.split(",")[0];
  document.querySelector("#story-city-copy").textContent = wedding.venue.split(",")[0];
  if (validSiteConfig?.story) document.querySelector("#story-lead").textContent = validSiteConfig.story;
  document.querySelector("#pass-couple").textContent = couple.toUpperCase();
  document.querySelector("#pass-date").textContent = `${String(event.getDate()).padStart(2, "0")} · ${String(event.getMonth() + 1).padStart(2, "0")} · ${String(event.getFullYear()).slice(-2)}`;
  document.querySelector("#pass-location").textContent = wedding.venue.toUpperCase();
  document.querySelector("#pass-time").textContent = `${new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(event).toUpperCase()} · 10:00 AM`;
  const rsvpDeadline = new Date(event);
  rsvpDeadline.setDate(rsvpDeadline.getDate() - 27);
  document.querySelector("#rsvp-deadline").textContent = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(rsvpDeadline);
  document.title = `${couple} — WeddingSite`;
  document.querySelector('meta[name="description"]').content = `A thoughtful home for the wedding of ${couple}: plans, music, memories and the people who make it special.`;
}
applyApprovedWeddingDetails();

const countdownDate = new Date(wedding.date);
function updateCountdown() {
  const remaining = Math.max(0, countdownDate.getTime() - Date.now());
  const values = {
    days: Math.floor(remaining / 86400000),
    hours: Math.floor((remaining % 86400000) / 3600000),
    minutes: Math.floor((remaining % 3600000) / 60000),
    seconds: Math.floor((remaining % 60000) / 1000)
  };
  for (const [unit, value] of Object.entries(values)) {
    const target = document.querySelector(`[data-count="${unit}"]`);
    target.textContent = unit === "days" ? String(value) : String(value).padStart(2, "0");
  }
}
updateCountdown();
setInterval(updateCountdown, 1000);

document.querySelector("#calendar-link").addEventListener("click", event => {
  event.preventDefault();
  const start = new Date(wedding.date);
  const end = new Date(start.getTime() + 9 * 60 * 60 * 1000);
  const format = date => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const escape = text => text.replace(/[,;\\]/g, character => `\\${character}`).replace(/\n/g, "\\n");
  const calendar = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WeddingSite//Wedding//EN", "BEGIN:VEVENT",
    `DTSTART:${format(start)}`, `DTEND:${format(end)}`, `SUMMARY:${escape(`${wedding.couple} — Wedding celebration`)}`,
    `LOCATION:${escape(wedding.venue)}`, "DESCRIPTION:Sample wedding details. Please confirm venue and schedule with the couple.",
    "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([calendar], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${wedding.couple.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-save-the-date.ics`;
  link.click();
  URL.revokeObjectURL(url);
  notify("Sample calendar invite downloaded. Please confirm the event details.");
});

const menuToggle = document.querySelector(".menu-toggle");
const navigation = document.querySelector(".main-nav");
menuToggle.addEventListener("click", () => {
  const isOpen = navigation.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", String(isOpen));
  menuToggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
});
navigation.addEventListener("click", event => {
  if (event.target.closest("a")) {
    navigation.classList.remove("open");
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open navigation");
  }
});

const soundToggle = document.querySelector("#sound-toggle");
let soundContext;
let soundMaster;
let soundOscillators = [];
soundToggle.addEventListener("click", async () => {
  if (soundMaster) {
    soundMaster.gain.cancelScheduledValues(soundContext.currentTime);
    soundMaster.gain.setTargetAtTime(0, soundContext.currentTime, 0.18);
    const activeOscillators = soundOscillators;
    soundOscillators = [];
    soundMaster = null;
    setTimeout(() => activeOscillators.forEach(oscillator => oscillator.stop()), 700);
    soundToggle.setAttribute("aria-pressed", "false");
    soundToggle.setAttribute("aria-label", "Turn ambient sound on");
    soundToggle.querySelector(".sound-label").textContent = "SOUND OFF";
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    notify("Ambient sound is not supported in this browser.");
    return;
  }
  try {
    soundContext ||= new AudioContextClass();
    await soundContext.resume();
  } catch {
    notify("Ambient sound could not start. Check your browser audio settings.");
    return;
  }
  const master = soundContext.createGain();
  master.gain.setValueAtTime(0, soundContext.currentTime);
  master.gain.setTargetAtTime(0.018, soundContext.currentTime, 0.8);
  master.connect(soundContext.destination);
  soundMaster = master;
  soundOscillators = [130.81, 196, 261.63, 329.63].map((frequency, index) => {
    const oscillator = soundContext.createOscillator();
    const partial = soundContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    partial.gain.value = index === 0 ? 0.55 : 0.22;
    oscillator.connect(partial);
    partial.connect(master);
    oscillator.start();
    return oscillator;
  });
  soundToggle.setAttribute("aria-pressed", "true");
  soundToggle.setAttribute("aria-label", "Turn ambient sound off");
  soundToggle.querySelector(".sound-label").textContent = "SOUND ON";
});

let selectedAmount = 25;
let selectedStreamIndex = 0;
let confirmedAttendees = weddingSettings.confirmedGuests;
const publicLedgerKey = "weddingsite-demo-public-ledger";
const demoLedgerSeed = [
  { id: "sample-1", displayName: "Auntie M.", visibility: "name", streamName: "Home fund", pledgedUsd: 250, paidUsd: 250, paymentStatus: "paid", createdAt: "2026-10-14T10:00:00Z" },
  { id: "sample-2", displayName: "Anonymous guest", visibility: "anonymous", streamName: "Honeymoon", pledgedUsd: 100, paidUsd: 0, paymentStatus: "pledged", createdAt: "2026-10-13T10:00:00Z" },
  { id: "sample-3", displayName: "Friends of the couple", visibility: "name", streamName: "Community table", pledgedUsd: 180, paidUsd: 180, paymentStatus: "paid", createdAt: "2026-10-12T10:00:00Z" },
  { id: "sample-4", displayName: "Anonymous guest", visibility: "anonymous", streamName: "Home fund", pledgedUsd: 75, paidUsd: 0, paymentStatus: "pledged", createdAt: "2026-10-11T10:00:00Z" },
  { id: "sample-5", displayName: "Uncle J.", visibility: "name", streamName: "Home fund", pledgedUsd: 300, paidUsd: 300, paymentStatus: "paid", createdAt: "2026-10-10T10:00:00Z" },
  { id: "sample-6", displayName: "Anonymous guest", visibility: "anonymous", streamName: "Honeymoon", pledgedUsd: 50, paidUsd: 0, paymentStatus: "pledged", createdAt: "2026-10-09T10:00:00Z" },
  { id: "sample-7", displayName: "Cousin R.", visibility: "name", streamName: "Community table", pledgedUsd: 90, paidUsd: 90, paymentStatus: "paid", createdAt: "2026-10-08T10:00:00Z" },
  { id: "sample-8", displayName: "Anonymous guest", visibility: "anonymous", streamName: "Home fund", pledgedUsd: 40, paidUsd: 0, paymentStatus: "pledged", createdAt: "2026-10-07T10:00:00Z" }
];
let publicLedgerEntries = [];
let ledgerPage = 0;
try {
  const storedLedger = JSON.parse(localStorage.getItem(publicLedgerKey) || "null");
  publicLedgerEntries = Array.isArray(storedLedger)
    ? storedLedger.filter(entry => entry && typeof entry.id === "string" &&
      typeof entry.displayName === "string" && typeof entry.streamName === "string" &&
      Number.isFinite(entry.pledgedUsd) && entry.pledgedUsd > 0 &&
      Number.isFinite(entry.paidUsd) && entry.paidUsd >= 0 &&
      ["pledged", "paid"].includes(entry.paymentStatus) &&
      ["name", "anonymous"].includes(entry.visibility))
    : demoLedgerSeed;
} catch {
  publicLedgerEntries = demoLedgerSeed;
  publicPreviewReadError = true;
}
function formatWeddingAmount(amountUsd) {
  return window.WeddingSiteFX.formatPrimaryUsd(amountUsd, window.WeddingSiteFX.currency());
}
function renderPublicLedger() {
  const rows = document.querySelector("#public-ledger-rows");
  const pageSize = 5;
  const sorted = [...publicLedgerEntries].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  ledgerPage = Math.min(ledgerPage, pageCount - 1);
  const pageRows = sorted.slice(ledgerPage * pageSize, (ledgerPage + 1) * pageSize);
  rows.replaceChildren();
  if (!pageRows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No contributors have opted into the public ledger yet.";
    row.append(cell);
    rows.append(row);
  }
  pageRows.forEach(entry => {
    const row = document.createElement("tr");
    const contributor = document.createElement("td");
    contributor.textContent = entry.visibility === "anonymous" ? "Anonymous guest" : entry.displayName;
    const stream = document.createElement("td");
    stream.textContent = entry.streamName;
    const pledged = document.createElement("td");
    pledged.textContent = formatWeddingAmount(entry.pledgedUsd);
    const paid = document.createElement("td");
    paid.textContent = entry.paidUsd > 0 ? formatWeddingAmount(entry.paidUsd) : "—";
    const status = document.createElement("td");
    status.textContent = entry.paymentStatus === "paid" ? "Paid · sample" : "Pledged · sample";
    status.className = `ledger-status ${entry.paymentStatus}`;
    row.append(contributor, stream, pledged, paid, status);
    rows.append(row);
  });
  const first = sorted.length ? ledgerPage * pageSize + 1 : 0;
  const last = Math.min((ledgerPage + 1) * pageSize, sorted.length);
  document.querySelector("#ledger-page-status").textContent = `Showing ${first}–${last} of ${sorted.length} · sample data`;
  document.querySelector("#ledger-prev").disabled = ledgerPage === 0;
  document.querySelector("#ledger-next").disabled = ledgerPage >= pageCount - 1;
}
function renderFundraisingStreams() {
  const streamSelect = document.querySelector("#fundraising-stream-select");
  const streamCards = document.querySelector("#fundraising-streams");
  streamSelect.replaceChildren();
  streamCards.replaceChildren();
  weddingSettings.streams.forEach((stream, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = stream.name;
    streamSelect.append(option);
    const card = document.createElement("article");
    card.className = "fundraising-stream-card";
    const name = document.createElement("strong");
    name.textContent = stream.name;
    const purpose = document.createElement("p");
    purpose.textContent = stream.purpose;
    const goal = document.createElement("small");
    goal.textContent = `Optional goal: ${formatWeddingAmount(stream.goalUsd)}`;
    const status = document.createElement("small");
    status.textContent = "Client-configured · demo only";
    card.append(name, purpose, goal, status);
    streamCards.append(card);
  });
  selectedStreamIndex = Math.min(selectedStreamIndex, weddingSettings.streams.length - 1);
  streamSelect.value = String(selectedStreamIndex);
  const primary = weddingSettings.streams[selectedStreamIndex];
  const raised = Number(primary.raisedUsd) || 0;
  const percent = Math.min(100, Math.round(raised / primary.goalUsd * 100));
  document.querySelector("#fundraising-primary-name").textContent = `${primary.name.toUpperCase()} · DEMO PROGRESS`;
  const progressLabel = document.querySelector(".progress-top>span:last-child");
  progressLabel.replaceChildren(document.createTextNode(`${percent}% `));
  const progressCaption = document.createElement("small");
  progressCaption.textContent = "OF GOAL · DEMO";
  progressLabel.append(progressCaption);
  const bar = document.querySelector(".progress-bar");
  bar.setAttribute("aria-valuenow", String(percent));
  bar.querySelector("span").style.width = `${percent}%`;
  document.querySelector(".progress-amount strong").textContent = formatWeddingAmount(raised);
  document.querySelector(".progress-amount>span").textContent = `Illustrative progress toward ${formatWeddingAmount(primary.goalUsd)} goal`;
}
function renderContributionBreakdown() {
  document.querySelector("#contribution-gross").textContent = `Your optional pledge: ${formatWeddingAmount(selectedAmount)} toward ${weddingSettings.streams[selectedStreamIndex]?.name || "the wedding fund"}`;
  document.querySelectorAll("[data-amount]").forEach(button => {
    if (Number(button.dataset.amount) > 0) button.textContent = formatWeddingAmount(Number(button.dataset.amount));
  });
}
function renderAttendanceCapacity() {
  const capacity = weddingSettings.capacity;
  const full = confirmedAttendees >= capacity;
  document.querySelector("#rsvp-capacity-status").textContent = full
    ? `Capacity reached · ${confirmedAttendees} of ${capacity}`
    : `${confirmedAttendees} of ${capacity} confirmed`;
  document.querySelector("#guest-attending").querySelector('option[value="yes"]').disabled = full;
  document.querySelector("#attendance-heading").textContent = full ? "Attendance is full" : "Will you attend?";
  document.querySelector("#rsvp-submit").disabled = full && document.querySelector("#guest-attending").value === "yes";
  document.querySelector("#diet-upgrade").disabled = full || document.querySelector("#guest-attending").value !== "yes";
}
function renderDietaryUpgrade() {
  const checked = document.querySelector("#diet-upgrade").checked;
  const details = document.querySelector("#diet-upgrade-details");
  details.hidden = !checked;
  document.querySelector("#guest-diet").disabled = !checked;
  document.querySelector("#dietary-cost-display").textContent = formatWeddingAmount(weddingSettings.dietaryCostUsd);
}
function renderWeddingPalette() {
  weddingSettings.palette.forEach((color, index) => {
    const swatch = document.querySelectorAll(".swatch-color")[index];
    if (swatch) swatch.closest(".swatch").hidden = false;
    if (swatch) swatch.style.backgroundColor = color;
    if (swatch?.nextElementSibling?.nextElementSibling) swatch.nextElementSibling.nextElementSibling.textContent = color.toUpperCase();
  });
  document.querySelectorAll(".swatch-color").forEach((swatch, index) => {
    if (index >= weddingSettings.palette.length) swatch.closest(".swatch").hidden = true;
  });
  document.documentElement.style.setProperty("--green", weddingSettings.palette[0] || "#244b3a");
  document.documentElement.style.setProperty("--sage", weddingSettings.palette[1] || "#a9b5a2");
  document.documentElement.style.setProperty("--gold", weddingSettings.palette[2] || "#be9b52");
}
function renderSongLeaderboard() {
  const list = document.querySelector("#song-list");
  const rows = [...list.querySelectorAll(".song-row")].sort((a, b) => Number(b.dataset.topBidUsd || 0) - Number(a.dataset.topBidUsd || 0));
  rows.forEach((row, index) => {
    row.querySelector(".song-title b").textContent = String(index + 1).padStart(2, "0");
    const amountUsd = Number(row.dataset.topBidUsd || 0);
    row.querySelector(".song-votes").textContent = amountUsd > 0 ? `Top demo bid · ${formatWeddingAmount(amountUsd)}` : "No demo bid yet";
    list.append(row);
  });
}
renderFundraisingStreams();
renderContributionBreakdown();
renderPublicLedger();
renderAttendanceCapacity();
renderDietaryUpgrade();
renderWeddingPalette();
renderSongLeaderboard();
document.querySelector("#display-currency").value = window.WeddingSiteFX.currency();
document.querySelector("#market-methods").textContent = `${demoMarketLabel} · Payments are not available yet. This is a local demo pledge only; no gateway options are configured.`;
document.querySelector("#display-currency").addEventListener("change", event => {
  window.WeddingSiteFX.choose(event.target.value);
  renderFundraisingStreams();
  renderContributionBreakdown();
  renderPublicLedger();
  renderDietaryUpgrade();
  renderSongLeaderboard();
});
document.addEventListener("weddingsitefxchange", event => {
  const message = event.detail.message;
  document.querySelector("#fx-status").textContent = message;
  document.querySelector("#fx-status").dataset.state = message.includes("STALE") || message.includes("unavailable") ? "stale" : "";
  document.querySelector("#display-currency").value = event.detail.currency;
  renderFundraisingStreams();
  renderContributionBreakdown();
  renderPublicLedger();
  renderDietaryUpgrade();
  renderSongLeaderboard();
});
window.addEventListener("storage", event => {
  if (event.key === weddingSettingsKey) {
    try {
      const settingRecord = JSON.parse(event.newValue || "null");
      const stored = settingRecord?.tenants?.amara || settingRecord;
      if (!stored || !window.WeddingSiteFX.options.includes(stored.currency) ||
          !Number.isInteger(stored.capacity) || stored.capacity < 1 ||
          !Number.isFinite(stored.dietaryCostUsd) || stored.dietaryCostUsd < 0 ||
          !Array.isArray(stored.palette) || stored.palette.length < 1 || stored.palette.length > 4 ||
          !stored.palette.every(color => /^#[0-9a-f]{6}$/i.test(color)) ||
          !Array.isArray(stored.streams) || stored.streams.length < 1 ||
          !stored.streams.every(stream => typeof stream.name === "string" && typeof stream.purpose === "string" && Number.isFinite(stream.goalUsd) && stream.goalUsd > 0)) throw new Error("Invalid wedding settings.");
      weddingSettings = stored;
      window.WeddingSiteFX.choose(weddingSettings.currency);
      renderFundraisingStreams();
      renderContributionBreakdown();
      renderAttendanceCapacity();
      renderDietaryUpgrade();
      renderWeddingPalette();
      renderSongLeaderboard();
    } catch {
      notify("Client wedding settings could not be refreshed. Existing preview settings remain in use.");
    }
    return;
  }
  if (event.key !== "weddingsite-demo-fee-config") return;
  try {
    const feeConfig = JSON.parse(event.newValue || "null");
    if (!feeConfig) throw new Error("Invalid demo fee policy.");
    demoMarketLabel = typeof feeConfig.market === "string" ? feeConfig.market : demoMarketLabel;
    document.querySelector("#market-methods").textContent = `${demoMarketLabel} · Payments are not available yet. This is a local demo pledge only; no gateway options are configured.`;
  } catch {
    notify("The platform fee policy could not be refreshed. The displayed estimate remains unchanged.");
  }
});
document.querySelectorAll("[data-amount]").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-amount]").forEach(option => option.classList.remove("selected"));
    button.classList.add("selected");
    selectedAmount = Number(button.dataset.amount);
    if (selectedAmount === 0) openDialog("Other contribution", "Choose an amount to contribute", "amount");
    else renderContributionBreakdown();
  });
});
document.querySelector("#fundraising-stream-select").addEventListener("change", event => {
  selectedStreamIndex = Number(event.target.value);
  renderContributionBreakdown();
});
document.querySelector("#guest-attending").addEventListener("change", event => {
  if (event.target.value !== "yes") {
    document.querySelector("#diet-upgrade").checked = false;
    document.querySelector("#diet-upgrade-confirm").checked = false;
  }
  renderDietaryUpgrade();
  renderAttendanceCapacity();
});
document.querySelector("#diet-upgrade").addEventListener("change", () => {
  document.querySelector("#diet-upgrade-confirm").checked = false;
  renderDietaryUpgrade();
});

const dialog = document.querySelector("#action-dialog");
const dialogContent = document.querySelector("#dialog-content");
function openDialog(title, description, kind = "message", context = null) {
  dialogContent.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = description;
  dialogContent.append(heading, paragraph);
  const form = document.createElement("form");
  form.className = "dialog-fields";
  form.method = "dialog";

  if (kind === "song") {
    form.innerHTML = '<input name="song" required maxlength="100" placeholder="Song title"><input name="artist" maxlength="100" placeholder="Artist">';
  } else if (kind === "bid") {
    const currency = window.WeddingSiteFX.currency();
    form.innerHTML = `<label>Optional bid amount (${currency})<input name="amount" required type="number" min="0.01" step="0.01" placeholder="Enter your own amount"></label><p class="fine-print">Highest demo bid ranks first for DJ priority. This is a pledge only; nothing is charged. A real checkout would require a separate review and confirmation.</p>`;
  } else if (kind === "task" || kind === "vendor" || kind === "announcement") {
    form.innerHTML = `<input name="title" required maxlength="100" placeholder="${kind === "task" ? "Task and owner" : kind === "vendor" ? "Vendor and next step" : "Announcement subject"}"><textarea name="details" maxlength="400" placeholder="${kind === "announcement" ? "Review draft text before sending" : "Notes or due date"}"></textarea>`;
  } else if (kind === "amount") {
    form.innerHTML = `<input name="amount" required type="number" min="0.01" step="0.01" placeholder="Amount in ${window.WeddingSiteFX.currency()}"><input name="note" maxlength="120" placeholder="Optional note">`;
  } else if (kind === "budget") {
    form.innerHTML = '<p class="fine-print">A connected planner can track estimates, actuals, due dates and reconciled contributions. No financial data is saved in this demo.</p>';
  } else if (kind === "ecard") {
    form.innerHTML = '<p class="fine-print">This is a decorative sample invitation. A real pass should use a random, expiring guest token verified by a secure check-in service—not personal information encoded in a public QR.</p>';
  } else if (kind === "payment") {
    form.innerHTML = `<p>You selected an optional pledge of <strong>${formatWeddingAmount(selectedAmount)}</strong> for <strong>${escapeText(weddingSettings.streams[selectedStreamIndex].name)}</strong>.</p><label>Public ledger identity (optional)<select name="visibility"><option value="hidden">Keep this pledge off the public ledger</option><option value="anonymous">Show as Anonymous guest</option><option value="name">Show a name I choose</option></select></label><label class="ledger-display-name" hidden>Your public display name<input name="displayName" maxlength="60" autocomplete="off" placeholder="Name or initials"></label><label class="ledger-consent"><input name="publicConsent" type="checkbox"><span>I consent to display the selected name or anonymous identity and this pledge amount publicly.</span></label><p class="fine-print">Your public choice is separate from payment status: this demo can record only a local pledge, never a paid transaction. No payment details are requested and no charge is initiated. You can keep the entry private by default.</p>`;
    const visibility = form.querySelector('[name="visibility"]');
    const nameField = form.querySelector(".ledger-display-name");
    const consent = form.querySelector('[name="publicConsent"]');
    visibility.addEventListener("change", () => {
      nameField.hidden = visibility.value !== "name";
      consent.required = visibility.value !== "hidden";
    });
  }

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button button-green";
  submit.textContent = kind === "announcement" ? "Save draft only" : kind === "payment" ? "Record demo pledge" : kind === "bid" ? "Place demo bid" : "Add to this demo";
  form.append(submit);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(form);
    const value = String(data.get("title") || data.get("song") || "");
    if (kind === "payment") {
      const visibility = String(data.get("visibility") || "hidden");
      const displayName = String(data.get("displayName") || "").trim();
      const consentGiven = data.get("publicConsent") === "on";
      if (visibility !== "hidden" && !consentGiven) {
        notify("Public display requires your separate, explicit consent. Your pledge has not been recorded.");
        return;
      }
      if (visibility === "name" && (!displayName || displayName.length > 60)) {
        notify("Enter a public display name of up to 60 characters, or choose anonymous/private.");
        return;
      }
      if (visibility !== "hidden") {
        const entry = {
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          displayName: visibility === "name" ? displayName : "Anonymous guest",
          visibility,
          streamName: weddingSettings.streams[selectedStreamIndex].name,
          pledgedUsd: selectedAmount,
          paidUsd: 0,
          paymentStatus: "pledged",
          createdAt: new Date().toISOString()
        };
        try {
          const updated = [entry, ...publicLedgerEntries];
          localStorage.setItem(publicLedgerKey, JSON.stringify(updated));
          publicLedgerEntries = updated;
          ledgerPage = 0;
          renderPublicLedger();
        } catch {
          notify("The local demo ledger could not save the entry. Nothing was recorded.");
          return;
        }
      }
    }
    if (kind === "task" && value) {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      const text = document.createElement("span");
      const taskName = document.createElement("b");
      taskName.textContent = value;
      const meta = document.createElement("small");
      meta.textContent = "Added locally · demo only";
      text.append(taskName, meta);
      label.append(checkbox, text);
      const state = document.createElement("span");
      state.className = "task-state";
      state.textContent = "TO DO";
      item.append(label, state);
      document.querySelector("#task-list").prepend(item);
    }
    if (kind === "song" && value) addSuggestedSong(value, String(data.get("artist") || "Guest suggestion"));
    if (kind === "bid") {
      const amount = Number(data.get("amount"));
      const amountUsd = window.WeddingSiteFX.convertToUsd(amount, window.WeddingSiteFX.currency());
      if (!Number.isFinite(amount) || amount <= 0 || amountUsd === null || !context) {
        notify("A valid bid could not be converted using the available FX rate. No bid was recorded.");
        return;
      }
      const previous = Number(context.dataset.topBidUsd || 0);
      if (amountUsd > previous) {
        context.dataset.topBidUsd = String(amountUsd);
        renderSongLeaderboard();
        notify("Your higher demo bid is now ranked. No charge was made.");
      } else {
        notify("Demo bid received; the song keeps its rank because its existing top bid is higher.");
      }
    }
    if (kind === "amount" && data.get("amount")) {
      const amount = Number(data.get("amount"));
      const amountUsd = window.WeddingSiteFX.convertToUsd(amount, window.WeddingSiteFX.currency());
      if (!Number.isFinite(amount) || amount <= 0 || amountUsd === null) { notify("Enter a positive amount and ensure the selected-currency FX rate is available."); return; }
      selectedAmount = amountUsd;
      renderContributionBreakdown();
    }
    dialog.close();
    const resultMessage = kind === "announcement" ? "Draft retained for organizer review. Nothing was sent."
      : kind === "payment" ? "Demo pledge recorded locally (or kept private as chosen). No payment was initiated; paid status was not changed."
        : kind === "bid" ? "Demo bid recorded locally. Highest amounts rank first; no charge was made."
          : "Added to this local demo only. Nothing was sent or saved.";
    notify(resultMessage);
  });
  dialogContent.append(form);
  dialog.showModal();
}

function addSuggestedSong(title, artist) {
  const row = document.createElement("article");
  row.className = "song-row";
  row.dataset.topBidUsd = "0";
  const titleCell = document.createElement("span");
  titleCell.className = "song-title";
  const rank = document.createElement("b");
  rank.textContent = "NEW";
  const name = document.createElement("strong");
  name.textContent = title;
  titleCell.append(rank, name);
  const artistCell = document.createElement("span");
  artistCell.textContent = artist;
  const votes = document.createElement("span");
  votes.className = "song-votes";
  votes.textContent = "No demo bid yet";
  const button = document.createElement("button");
  button.className = "vote-button";
  button.type = "button";
  button.textContent = "＋ BID";
  button.setAttribute("aria-label", `Place a demo bid for ${title}`);
  row.append(titleCell, artistCell, votes, button);
  document.querySelector("#song-list").append(row);
}

document.querySelector("#song-list").addEventListener("click", event => {
  const button = event.target.closest(".vote-button");
  if (!button) return;
  const row = button.closest(".song-row");
  const song = row.querySelector(".song-title strong").textContent;
  openDialog(`Bid for ${song}`, "Enter the amount you choose in the wedding currency. Highest demo bid ranks first for DJ priority.", "bid", row);
});
document.querySelector("#ledger-prev").addEventListener("click", () => {
  ledgerPage = Math.max(0, ledgerPage - 1);
  renderPublicLedger();
});
document.querySelector("#ledger-next").addEventListener("click", () => {
  ledgerPage += 1;
  renderPublicLedger();
});

document.querySelector("#rsvp-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = document.querySelector("#guest-name").value.trim();
  const attendance = document.querySelector("#guest-attending").value;
  const upgradeRequested = document.querySelector("#diet-upgrade").checked;
  if (attendance === "yes" && confirmedAttendees >= weddingSettings.capacity) {
    renderAttendanceCapacity();
    document.querySelector("#rsvp-feedback").textContent = "The guest capacity has been reached. The Client may update capacity, but this RSVP was not accepted.";
    return;
  }
  if (upgradeRequested && attendance !== "yes") {
    document.querySelector("#rsvp-feedback").textContent = "Select Yes to attend before requesting the optional meal accommodation.";
    return;
  }
  if (upgradeRequested && !document.querySelector("#diet-upgrade-confirm").checked) {
    document.querySelector("#rsvp-feedback").textContent = "Please confirm the optional accommodation and its client-funded budget estimate, or leave it unselected.";
    return;
  }
  if (attendance === "yes") confirmedAttendees += 1;
  const response = attendance === "yes" ? "Attendance confirmed" : "Thank you for letting us know";
  const upgrade = upgradeRequested ? ` Optional premium meal accommodation requested; estimated ${formatWeddingAmount(weddingSettings.dietaryCostUsd)} from the couple’s budget, not yours.` : "";
  document.querySelector("#rsvp-feedback").textContent = `${response}, ${name}.${upgrade} Demo only—your response was not sent or saved.`;
  event.target.reset();
  renderDietaryUpgrade();
  renderAttendanceCapacity();
});

document.querySelectorAll("[data-action]").forEach(button => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    const actions = {
      payment: () => openDialog("Demo contribution", "Your generosity means so much. No payment details should be entered here.", "payment"),
      "suggest-song": () => openDialog("Suggest a song", "Share a track for the couple to review. The sample leaderboard changes only in this browser.", "song"),
      ecard: () => openDialog("Sample invitation pass", "A safe preview of a possible guest pass. This demo has no guest-specific invitation or check-in verification.", "ecard"),
      organizer: () => document.querySelector("#organizer").scrollIntoView({ behavior: "smooth" }),
      task: () => openDialog("Add a planning task", "Capture a next step for this browser-only preview.", "task"),
      vendor: () => openDialog("Add a vendor note", "A real workspace should include a named owner, contract status and access permissions.", "vendor"),
      budget: () => openDialog("Budget planner", "Planning figures on this page are fictional. Never treat a chat message or screenshot as proof of payment.", "budget"),
      announcement: () => openDialog("Review announcement", "Review the audience, consent and wording before a real message is approved.", "announcement")
    };
    actions[action]?.();
  });
});

const demoUpdates = document.querySelector("#demo-published-updates");
if (demoUpdates) {
  if (publicPreviewReadError) {
    notify("Could not read the local preview update. No website content was changed.");
  }
  const section = document.createElement("section");
  section.className = "demo-updates";
  const heading = document.createElement("h2");
  heading.textContent = "Client-approved updates · local preview";
  section.append(heading);
  approvedPreviewUpdates.forEach(update => {
    if (typeof update.title !== "string" || typeof update.excerpt !== "string") return;
    const article = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = update.title;
    const excerpt = document.createElement("p");
    excerpt.textContent = update.excerpt;
    article.append(title, excerpt);
    section.append(article);
  });
  if (section.querySelector("article")) demoUpdates.replaceWith(section);
}
