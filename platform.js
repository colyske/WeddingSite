const tenants = {
  amara: { label: "Amara & Kito", couple: "Amara Njeri & Kito Mwangi", date: "2026-12-12", location: "Nairobi, Kenya", domain: "amara-kito.weddingsite.demo", status: "IN PLANNING", preview: true },
  zuri: { label: "Zuri & Daniel", couple: "Zuri Achieng & Daniel Otieno", date: "2027-03-20", location: "Mombasa, Kenya", domain: "zuri-daniel.weddingsite.demo", status: "SETUP IN PROGRESS", preview: false },
  nala: { label: "Nala & Brian", couple: "Nala Wambui & Brian Kamau", date: "2027-08-14", location: "Naivasha, Kenya", domain: "nala-brian.weddingsite.demo", status: "SETUP IN PROGRESS", preview: false }
};
let currentTenant = "amara";
let currentRole = "Client";
let toastTimer;
let newTenantCounter = 0;
const feeConfigKey = "weddingsite-demo-fee-config";
const paidSitesKey = "weddingsite-demo-publication-payments";
const weddingSettingsKey = "weddingsite-demo-wedding-settings";
let feeConfig = { publicationFee: 25, contributionFee: 5, currency: "USD", locale: "en-US", market: "Global · English (US)", paymentMethods: "No payment gateways configured" };
const defaultWeddingSettings = {
  currency: "USD",
  capacity: 150,
  dietaryCostUsd: 35,
  palette: ["#244b3a", "#a9b5a2", "#be9b52", "#eee8d9"],
  streams: [
    { name: "Home fund", purpose: "Build our first home together", goalUsd: 10000, raisedUsd: 6200 },
    { name: "Honeymoon", purpose: "A restful first trip together", goalUsd: 4000, raisedUsd: 0 },
    { name: "Community table", purpose: "Make room for family and friends", goalUsd: 2500, raisedUsd: 0 }
  ]
};
let weddingSettingsByTenant = {};
let weddingSettings = defaultWeddingSettings;
let publicationPayments = {};
try {
  const savedFeeConfig = JSON.parse(localStorage.getItem(feeConfigKey) || "null");
  if (savedFeeConfig && Number.isFinite(savedFeeConfig.publicationFee) && Number.isFinite(savedFeeConfig.contributionFee)) {
    feeConfig = {
      publicationFee: savedFeeConfig.publicationFee,
      contributionFee: savedFeeConfig.contributionFee,
      currency: window.WeddingSiteFX.options.includes(savedFeeConfig.currency) ? savedFeeConfig.currency : "USD",
      locale: typeof savedFeeConfig.locale === "string" ? savedFeeConfig.locale : "en-US",
      market: typeof savedFeeConfig.market === "string" ? savedFeeConfig.market : "Global · English (US)",
      paymentMethods: typeof savedFeeConfig.paymentMethods === "string" ? savedFeeConfig.paymentMethods : "No payment gateways configured"
    };
  }
  const savedPayments = JSON.parse(localStorage.getItem(paidSitesKey) || "{}");
  if (savedPayments && typeof savedPayments === "object" && !Array.isArray(savedPayments)) publicationPayments = savedPayments;
  const storedWeddingSettings = JSON.parse(localStorage.getItem(weddingSettingsKey) || "null");
  weddingSettingsByTenant = storedWeddingSettings?.tenants && typeof storedWeddingSettings.tenants === "object"
    ? storedWeddingSettings.tenants : {};
} catch {
  setTimeout(() => notify("Could not read saved demo fee settings. Default demo terms are shown; no payment state was changed."), 0);
}
let queue = [
  { id: 1, type: "PROGRAM", title: "Ceremony & reception schedule", excerpt: "Ceremony begins at 10:00 AM at Karura Community Chapel. Family-style lunch and dancing follow at Ngong Hills Estate.", by: "Program committee · 06 Oct", state: "pending" },
  { id: 2, type: "GUEST GUIDANCE", title: "Attire palette note", excerpt: "Formal African elegance is the feeling. Forest green, eucalyptus sage and royal gold are palette inspiration—not a strict rulebook.", by: "Client draft · 09 Oct", state: "pending" },
  { id: 3, type: "TRAVEL", title: "Venue directions", excerpt: "Add confirmed map links and shuttle arrival guidance after the transport committee verifies pickup points.", by: "Guest care committee · 11 Oct", state: "pending" }
];
let minutes = [
  { date: "06 OCT 2026", committee: "Planning committee", notes: "Family-style lunch confirmed. Shuttle count and rain plan still need a final decision.", decision: "Proceed with courtyard layout; review rain contingency at next meeting.", owner: "Amara", category: "Meeting minutes" },
  { date: "29 SEP 2026", committee: "Finance committee", notes: "Venue deposit is due after the couple checks the updated contract. Several family pledges were noted.", decision: "Treasurer to reconcile cleared deposits against the provider statement.", owner: "Peter · Treasurer", category: "Meeting minutes" }
];
let tasks = [
  { title: "Confirm shuttle pickup points", owner: "Guest care · Wanjiku", due: "Due 14 Nov" },
  { title: "Collect final catering headcount", owner: "Planning · Amara", due: "Due 15 Nov" },
  { title: "Review rain contingency with venue", owner: "Program · Kito", due: "Due 18 Nov" },
  { title: "Reconcile received deposits", owner: "Finance · Peter", due: "Verify independently" }
];
let members = [
  { name: "Amara Njeri", email: "amara@example.demo", role: "Client", initials: "AN" },
  { name: "Kito Mwangi", email: "kito@example.demo", role: "Client", initials: "KM" },
  { name: "Wanjiku M.", email: "wanjiku@example.demo", role: "Admin", initials: "WM" },
  { name: "Peter K.", email: "peter@example.demo", role: "Admin", initials: "PK" },
  { name: "Noah Otieno", email: "noah@example.demo", role: "SuperAdmin", initials: "NO" }
];
let activity = [
  { title: "Workspace opened", detail: "Client · demo activity", time: "Just now" },
  { title: "Minutes recorded", detail: "Planning committee · 06 October", time: "06 Oct" },
  { title: "Client site draft created", detail: "Initial invitation preview · sample content", time: "01 Oct" },
  { title: "Workspace members invited", detail: "Committee and platform roles · sample records", time: "28 Sep" }
];
let financeSampleContributions = [
  { stream: "Home fund", status: "Paid", pledgedUsd: 1000, paidUsd: 500 },
  { stream: "Honeymoon", status: "Part-paid", pledgedUsd: 400, paidUsd: 200 },
  { stream: "Community table", status: "Paid", pledgedUsd: 250, paidUsd: 120 }
];
let financeSampleExpenses = [
  { category: "Venue", description: "Ceremony & reception", amountUsd: 7400, status: "Paid", due: "12 Dec 2026" },
  { category: "Catering", description: "Confirmed deposit", amountUsd: 5000, status: "Paid", due: "15 Nov 2026" },
  { category: "Transport", description: "Shuttle estimate", amountUsd: 3200, status: "Proposed", due: "18 Nov 2026" },
  { category: "Attire & decor", description: "Supplier estimate", amountUsd: 2800, status: "Approved", due: "30 Nov 2026" }
];
let financeSamplePayouts = [{ amountUsd: 500, status: "Requested · not sent", requested: "14 Oct 2026" }];
let financeSampleReconciliations = [{ reference: "Provider statement · sample-104", expectedUsd: 500, reportedUsd: 497.5, status: "Pending review", date: "14 Oct 2026" }];
let financeSampleAudit = [
  { actor: "Treasurer · sample", action: "Reconciliation evidence entered", record: "sample-104", time: "14 Oct 2026" },
  { actor: "Client · sample", action: "Budget estimate updated", record: "Venue", time: "12 Oct 2026" },
  { actor: "Provider webhook · sample", action: "Contribution marked paid", record: "Home fund · $500 demo", time: "10 Oct 2026" }
];
let financeSampleBudget = { plannedUsd: 18400, actualUsd: 12400 };
queue.forEach(item => { item.tenant = "amara"; });
minutes.forEach(record => { record.tenant = "amara"; });
tasks.forEach(task => { task.tenant = "amara"; });
members.forEach(member => { member.tenant = "amara"; });
activity.forEach(entry => { entry.tenant = "amara"; });

const toast = document.querySelector("#toast");
const dialog = document.querySelector("#platform-dialog");
const dialogContent = document.querySelector("#platform-dialog-content");
function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}
function escapeText(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function canPublish() { return currentRole === "Client"; }
function isPublicationFeePaid(tenant = currentTenant) { return feeConfig.publicationFee === 0 || publicationPayments[tenant] === feeConfig.publicationFee; }
function formatUsd(amount) { return window.WeddingSiteFX.formatPrimaryUsd(amount, window.WeddingSiteFX.currency(), feeConfig.locale); }
function getWeddingSettings(tenant) {
  const saved = weddingSettingsByTenant[tenant];
  if (!saved || !window.WeddingSiteFX.options.includes(saved.currency) ||
      !Number.isInteger(saved.capacity) || saved.capacity < 1 ||
      !Number.isFinite(saved.dietaryCostUsd) || saved.dietaryCostUsd < 0 ||
      !Array.isArray(saved.palette) || saved.palette.length < 1 || saved.palette.length > 4 || !saved.palette.every(color => /^#[0-9a-f]{6}$/i.test(color)) ||
      !Array.isArray(saved.streams) || saved.streams.length < 1 ||
      !saved.streams.every(stream => stream && typeof stream.name === "string" && typeof stream.purpose === "string" && Number.isFinite(stream.goalUsd) && stream.goalUsd > 0 && Number.isFinite(stream.raisedUsd))) {
    return { ...JSON.parse(JSON.stringify(defaultWeddingSettings)), currency: feeConfig.currency };
  }
  return saved;
}
function convertInputFromUsd(amountUsd, currency) {
  const value = window.WeddingSiteFX.convertUsd(amountUsd, currency);
  return value === null ? "" : value.toFixed(2);
}
function renderPrivateFundraisingBreakdown() {
  const gross = 100;
  const fee = Math.round(gross * feeConfig.contributionFee) / 100;
  document.querySelector("#client-fee-breakdown").textContent =
    `Illustrative ${formatUsd(gross)} contribution − ${formatUsd(fee)} platform fee (${feeConfig.contributionFee}%) = ${formatUsd(gross - fee)} estimated for the couple.`;
}
function updateDietaryBudgetImpact() {
  const form = document.querySelector("#wedding-settings-form");
  const currency = form.elements.currency.value;
  const capacity = Number(form.elements.capacity.value);
  const perGuest = Number(form.elements.dietaryCost.value);
  const budgetUsd = window.WeddingSiteFX.convertToUsd(perGuest, currency);
  document.querySelector("#wedding-currency-label").textContent = currency;
  document.querySelector("#dietary-budget-impact").textContent = budgetUsd === null
    ? `Budget conversion unavailable for ${currency}`
    : window.WeddingSiteFX.formatPrimaryUsd(budgetUsd * capacity, currency, feeConfig.locale);
}
function renderWeddingSettings() {
  weddingSettings = getWeddingSettings(currentTenant);
  const form = document.querySelector("#wedding-settings-form");
  form.dataset.dirty = "false";
  form.elements.currency.value = weddingSettings.currency;
  form.elements.capacity.value = weddingSettings.capacity;
  form.elements.dietaryCost.value = convertInputFromUsd(weddingSettings.dietaryCostUsd, weddingSettings.currency);
  [1, 2, 3, 4].forEach(index => {
    const color = weddingSettings.palette[index - 1];
    form.elements[`paletteEnabled${index}`].checked = Boolean(color);
    form.elements[`palette${index}`].value = color || defaultWeddingSettings.palette[index - 1];
  });
  form.elements.streams.value = weddingSettings.streams.map(stream => {
    const goal = convertInputFromUsd(stream.goalUsd, weddingSettings.currency);
    return `${stream.name} | ${stream.purpose} | ${goal}`;
  }).join("\n");
  updateDietaryBudgetImpact();
  renderPrivateFundraisingBreakdown();
  document.querySelector(".client-finance").hidden = currentRole === "SuperAdmin";
  form.querySelectorAll("input,select,textarea,button").forEach(control => {
    control.disabled = currentRole !== "Client";
  });
}
function hasSensitiveSiteContent(value) {
  const withoutDates = String(value).replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
  const phoneLike = /(?:\+?\d[\s().-]*){10,}/.test(withoutDates);
  return /\b(password|pin|bank|account number|mpesa|m-pesa|payment|paid|pledge|dietary|allerg|medical|accessibility|disability|private|confidential|phone number|email address|passport|id number)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(withoutDates) || phoneLike;
}
function saveApprovedPreview(item) {
  const saved = JSON.parse(localStorage.getItem("weddingsite-demo-approved-site-copy") || "[]");
  if (!Array.isArray(saved)) throw new Error("Saved demo site updates are invalid.");
  saved.push({ id: item.id, tenant: item.tenant, title: item.title, excerpt: item.excerpt, siteConfig: item.siteConfig || undefined, publishedAt: new Date().toISOString() });
  localStorage.setItem("weddingsite-demo-approved-site-copy", JSON.stringify(saved));
}
function renderFeeSettings() {
  document.querySelector("#publication-fee-amount").textContent = formatUsd(feeConfig.publicationFee);
  document.querySelector("#publication-fee-status").textContent = isPublicationFeePaid()
    ? "Demo fee marked paid. Site edits remain free."
    : "Payment required before the client site can be published.";
  document.querySelector("#pay-publication-fee").hidden = isPublicationFeePaid() || currentRole === "Admin" || currentRole === "SuperAdmin";
  document.querySelector("#pay-publication-fee").textContent = `Pay ${formatUsd(feeConfig.publicationFee)} demo fee`;
  document.querySelector("#publication-fee-card").hidden = currentRole === "SuperAdmin";
  const settingsForm = document.querySelector("#fee-settings-form");
  settingsForm.elements.publicationFee.value = feeConfig.publicationFee;
  settingsForm.elements.contributionFee.value = feeConfig.contributionFee;
  settingsForm.elements.currency.value = feeConfig.currency;
  settingsForm.elements.locale.value = feeConfig.locale;
  settingsForm.elements.market.value = feeConfig.market;
  settingsForm.elements.paymentMethods.value = feeConfig.paymentMethods;
  document.querySelector("#platform-fee-example").textContent = "";
  const gross = 25;
  const fee = Math.round(gross * feeConfig.contributionFee) / 100;
  document.querySelector("#platform-fee-example").textContent = `${formatUsd(gross)} contribution − ${formatUsd(fee)} platform fee (${feeConfig.contributionFee}%) = ${formatUsd(gross - fee)} estimated for the couple.`;
  const rateStatus = window.WeddingSiteFX.statusText();
  document.querySelector("#settings-fx-status").textContent = rateStatus;
  document.querySelector("#settings-fx-status").dataset.state = rateStatus.includes("STALE") || rateStatus.includes("unavailable") ? "stale" : "";
  document.querySelector("#display-currency").value = window.WeddingSiteFX.currency();
  document.querySelectorAll("[data-amount-usd]").forEach(element => {
    element.textContent = formatUsd(Number(element.dataset.amountUsd));
  });
}
function appendFinanceCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}
function renderFinancePage() {
  const currency = weddingSettings.currency;
  const feeRate = feeConfig.contributionFee / 100;
  const pledged = financeSampleContributions.reduce((total, item) => total + item.pledgedUsd, 0);
  const grossPaid = financeSampleContributions.reduce((total, item) => total + item.paidUsd, 0);
  const platformFees = Math.round(grossPaid * feeRate * 100) / 100;
  const net = grossPaid - platformFees;
  const proposed = financeSampleExpenses.filter(item => item.status === "Proposed").reduce((total, item) => total + item.amountUsd, 0);
  const approved = financeSampleExpenses.filter(item => item.status === "Approved").reduce((total, item) => total + item.amountUsd, 0);
  const paidExpenses = financeSampleExpenses.filter(item => item.status === "Paid").reduce((total, item) => total + item.amountUsd, 0);
  const requestedPayouts = financeSamplePayouts.filter(item => item.status.startsWith("Requested")).reduce((total, item) => total + item.amountUsd, 0);
  const sentPayouts = financeSamplePayouts.filter(item => item.status.startsWith("Sent")).reduce((total, item) => total + item.amountUsd, 0);
  const isSuperAdmin = currentRole === "SuperAdmin";
  document.querySelector("#wedding-finance-metrics").hidden = isSuperAdmin;
  document.querySelector("#wedding-finance-details").hidden = isSuperAdmin;
  document.querySelector("#platform-finance-metrics").hidden = !isSuperAdmin;
  document.querySelector("#finance-role-scope").textContent = isSuperAdmin
    ? "Platform-wide aggregate view · SuperAdmin · no wedding-level guest finance"
    : currentRole === "Admin"
      ? "Assigned Admin view · private fee details, expense proposals and reconciliation"
      : "Client view · private fee details, own budget controls and payout requests";
  if (!isSuperAdmin) {
    document.querySelector("#finance-pledged").textContent = formatUsd(pledged);
    document.querySelector("#finance-gross").textContent = formatUsd(grossPaid);
    document.querySelector("#finance-fees").textContent = formatUsd(platformFees);
    document.querySelector("#finance-net").textContent = formatUsd(net);
    document.querySelector("#finance-expenses").textContent = `${formatUsd(proposed + approved + paidExpenses)} / ${formatUsd(paidExpenses)}`;
    document.querySelector("#finance-payouts").textContent = `${formatUsd(requestedPayouts + sentPayouts)} · ${financeSamplePayouts.length}`;
    document.querySelector("#finance-budget").textContent = `${formatUsd(financeSampleBudget.plannedUsd)} / ${formatUsd(financeSampleBudget.actualUsd)}`;
    document.querySelector("#finance-available").textContent = formatUsd(Math.max(0, net - requestedPayouts - sentPayouts));
    document.querySelector("#finance-pledged-count").textContent = `${financeSampleContributions.length} demo records · not cash`;
    document.querySelector("#finance-policy-rate").textContent = `${feeConfig.contributionFee}%`;
  }

  const contributions = document.querySelector("#finance-contribution-rows");
  contributions.replaceChildren();
  financeSampleContributions.forEach(item => {
    const row = document.createElement("tr");
    appendFinanceCell(row, item.stream);
    appendFinanceCell(row, item.status, `finance-status ${item.status === "Paid" ? "paid" : "pending"}`);
    appendFinanceCell(row, formatUsd(item.pledgedUsd));
    appendFinanceCell(row, item.paidUsd > 0 ? formatUsd(item.paidUsd) : "—");
    const fee = Math.round(item.paidUsd * feeRate * 100) / 100;
    appendFinanceCell(row, item.paidUsd > 0 ? formatUsd(fee) : "—");
    appendFinanceCell(row, item.paidUsd > 0 ? formatUsd(item.paidUsd - fee) : "—");
    contributions.append(row);
  });
  const expenses = document.querySelector("#finance-expense-rows");
  expenses.replaceChildren();
  financeSampleExpenses.forEach(item => {
    const row = document.createElement("tr");
    appendFinanceCell(row, item.category);
    appendFinanceCell(row, item.description);
    appendFinanceCell(row, formatUsd(item.amountUsd));
    appendFinanceCell(row, item.status, `finance-status ${item.status.toLowerCase()}`);
    appendFinanceCell(row, item.due || "Not set");
    expenses.append(row);
  });
  const payouts = document.querySelector("#finance-payout-rows");
  payouts.replaceChildren();
  financeSamplePayouts.forEach(item => {
    const row = document.createElement("tr");
    appendFinanceCell(row, formatUsd(item.amountUsd));
    appendFinanceCell(row, item.status, `finance-status ${item.status.startsWith("Sent") ? "paid" : "requested"}`);
    appendFinanceCell(row, item.requested);
    payouts.append(row);
  });
  const reconciliations = document.querySelector("#finance-reconciliation-rows");
  reconciliations.replaceChildren();
  financeSampleReconciliations.forEach(item => {
    const row = document.createElement("tr");
    appendFinanceCell(row, item.date);
    appendFinanceCell(row, item.reference);
    appendFinanceCell(row, formatUsd(item.expectedUsd));
    appendFinanceCell(row, formatUsd(item.reportedUsd));
    appendFinanceCell(row, formatUsd(item.reportedUsd - item.expectedUsd), "amount-negative");
    appendFinanceCell(row, item.status, "finance-status pending");
    reconciliations.append(row);
  });
  const audit = document.querySelector("#finance-audit-rows");
  audit.replaceChildren();
  financeSampleAudit.slice(0, 8).forEach(item => {
    const row = document.createElement("tr");
    appendFinanceCell(row, item.time);
    appendFinanceCell(row, item.actor);
    appendFinanceCell(row, item.action);
    appendFinanceCell(row, item.record);
    audit.append(row);
  });
  const alerts = document.querySelector("#finance-alert-list");
  alerts.replaceChildren();
  const alertItems = [
    [`${financeSampleReconciliations.filter(item => item.status === "Pending review").length} reconciliation item(s) need independent review`, "A statement difference never changes a pledge to paid."],
    [`${financeSamplePayouts.filter(item => item.status.startsWith("Requested")).length} payout request(s) awaiting approval`, "No payout execution route is enabled."],
    [`Meal accommodation budget ceiling: ${formatUsd(weddingSettings.dietaryCostUsd * weddingSettings.capacity)}`, "Optional guest requests are client-funded, never charged to guests."]
  ];
  alertItems.forEach(([title, detail]) => {
    const item = document.createElement("div"); item.className = "finance-alert";
    const dot = document.createElement("i");
    const body = document.createElement("div");
    const heading = document.createElement("b"); heading.textContent = title;
    const small = document.createElement("small"); small.textContent = detail;
    body.append(heading, small); item.append(dot, body); alerts.append(item);
  });
  document.querySelector("#finance-payout-request").hidden = currentRole !== "Client";
  document.querySelector("#finance-budget-form").querySelectorAll("input,button").forEach(control => { control.disabled = currentRole !== "Client"; });
  document.querySelector("#finance-expense-form").querySelectorAll("input,button").forEach(control => { control.disabled = !["Client", "Admin"].includes(currentRole); });
  document.querySelector("#finance-reconcile-form").querySelectorAll("input,button").forEach(control => { control.disabled = !["Client", "Admin"].includes(currentRole); });
}
function publishSafeDraftsAfterPayment(tenant) {
  const drafts = queue.filter(item => item.tenant === tenant && item.state === "pending" && item.aiStatus === "safe" && item.siteConfig);
  const latest = drafts[0];
  if (latest) {
    try {
      saveApprovedPreview(latest);
      latest.state = "approved";
      drafts.slice(1).forEach(item => { item.state = "superseded"; });
      logActivity("Safe wedding details auto-published", `${latest.title} · local demo policy check; no AI service connected.`);
    } catch {
      notify("The demo fee was recorded, but an approved preview update could not be saved. The site was not updated.");
    }
  }
  renderQueue();
}
function canManagePeople() { return ["SuperAdmin", "Admin", "Client"].includes(currentRole); }
function canEditContent() { return ["Client", "Admin"].includes(currentRole); }
function currentActorName() { return currentRole === "Client" ? "Amara Njeri" : currentRole === "Admin" ? "Wanjiku M." : "Noah Otieno"; }
function canManageMember(member) {
  if (member.name === currentActorName()) return false;
  if (currentRole === "SuperAdmin") return member.role !== "SuperAdmin";
  if (currentRole === "Admin") return member.role === "Client";
  if (currentRole === "Client") return member.role === "Client" || member.role === "Admin";
  return false;
}
function assignableRoles(member) {
  if (member.name === currentActorName()) return [member.role];
  if (currentRole === "SuperAdmin") return member.role === "SuperAdmin" ? ["SuperAdmin"] : ["Client", "Admin"];
  if (currentRole === "Client") return ["Client", "Admin"];
  if (currentRole === "Admin") return member.role === "Client" ? ["Client"] : [member.role];
  return [member.role];
}
function logActivity(title, detail) {
  activity.unshift({ title, detail, time: "Just now", tenant: currentTenant });
  renderActivity();
}
function renderActivity() {
  const container = document.querySelector("#audit-list");
  container.replaceChildren();
  activity.filter(entry => entry.tenant === currentTenant).forEach(entry => {
    const row = document.createElement("article");
    row.className = "audit-row";
    const dot = document.createElement("i"); dot.className = "audit-dot";
    const body = document.createElement("div");
    const title = document.createElement("b"); title.textContent = entry.title;
    const detail = document.createElement("p"); detail.textContent = entry.detail;
    body.append(title, detail);
    const time = document.createElement("time"); time.textContent = entry.time;
    row.append(dot, body, time); container.append(row);
  });
}

function renderQueue() {
  const overview = document.querySelector("#overview-queue");
  const all = document.querySelector("#publish-queue");
  overview.replaceChildren(); all.replaceChildren();
  const pending = queue.filter(item => item.tenant === currentTenant && item.state === "pending");
  document.querySelector("#publish-stat").textContent = String(pending.length);
  document.querySelector("#publish-heading-count").textContent = String(pending.length);
  document.querySelectorAll(".pending-count").forEach(item => { item.textContent = String(pending.length); item.hidden = pending.length === 0; });
  if (!pending.length) {
    const done = document.createElement("p"); done.className = "form-footnote"; done.textContent = "Everything submitted has been reviewed. Approved changes remain demo-only and are not published to a live guest site.";
    overview.append(done);
  }
  pending.slice(0, 3).forEach(item => {
    const row = document.createElement("div"); row.className = "approval-item";
    const kind = document.createElement("span"); kind.className = "approval-kind"; kind.textContent = "↗";
    const body = document.createElement("span");
    const title = document.createElement("b"); title.textContent = item.title;
    const meta = document.createElement("small"); meta.textContent = `${item.type} · ${item.by}`;
    body.append(title, meta);
    const arrow = document.createElement("i"); arrow.textContent = "›";
    row.append(kind, body, arrow); overview.append(row);
  });
  if (!pending.length) {
    const done = document.createElement("div"); done.className = "publish-card";
    const text = document.createElement("p"); text.textContent = "No items are waiting for client review. Published site content is unchanged in this demo.";
    done.append(text); all.append(done);
  }
  pending.forEach(item => {
    const card = document.createElement("article"); card.className = "publish-card";
    const head = document.createElement("div"); head.className = "publish-card-head";
    const type = document.createElement("span"); type.className = "queue-type"; type.textContent = item.type;
    const title = document.createElement("h2"); title.textContent = item.title;
    head.append(type, title);
    const buttons = document.createElement("div"); buttons.className = "publish-actions";
    const deny = document.createElement("button"); deny.type = "button"; deny.textContent = "Return for edits";
    deny.addEventListener("click", () => { item.state = "returned"; logActivity("Draft returned for edits", `${item.title} · ${currentRole}`); renderQueue(); notify("Returned to the committee. No guest-facing site was changed."); });
    const approve = document.createElement("button"); approve.type = "button"; approve.className = "approve-publish"; approve.textContent = "Approve for site";
    approve.disabled = !canPublish();
    approve.title = approve.disabled ? "Only the Client can approve publication" : "Approve sample draft";
    approve.addEventListener("click", () => {
      if (!canPublish()) { notify("Client approval is required before a guest-facing update can be published."); return; }
      if (!isPublicationFeePaid(item.tenant)) { notify("Pay the one-time publication fee before publishing this wedding site."); switchPage("website"); return; }
      try {
        saveApprovedPreview(item);
        item.state = "approved";
        logActivity("Client-approved site update", `${item.title} · approved by ${currentRole}; preview updated on this browser.`);
        renderQueue();
        notify("Client-approved and added to the generated preview on this browser only. This is not a hosted publication.");
      } catch {
        notify("Could not save the approved preview update in this browser; the guest-facing site was not changed.");
      }
    });
    buttons.append(deny, approve);
    if (item.aiStatus === "review") {
      const review = document.createElement("button"); review.type = "button"; review.textContent = "Review safe public copy";
      review.addEventListener("click", () => {
        if (!canPublish()) { notify("Only the Client can review and approve guest-facing copy."); return; }
        showDialog("Human review: rewrite guest-facing copy", "The local safety check flagged this edit. The private draft is shown only in this Client review dialog; it is withheld from the queue card and guest site. Replace it with safe, non-sensitive wording, or close this dialog and keep it private.", [
          { name: "copy", label: "Safe public wording", multiline: true, required: true, maxLength: 500, placeholder: "Write a concise guest-facing version", value: item.privateStory || "" }
        ], values => {
          if (hasSensitiveSiteContent(values.copy)) { notify("This wording still looks sensitive. Nothing was published; revise it or keep it private."); return; }
          item.excerpt = values.copy;
          item.siteConfig = { ...item.privateSiteConfig, story: values.copy };
          item.aiStatus = "client-review";
          item.title = "Client-rewritten wedding-site update";
          renderQueue();
          notify("Human-reviewed wording is ready. It remains unpublished until the Client explicitly approves it.");
        }, "Save for Client approval");
      });
      buttons.append(review);
    }
    const excerpt = document.createElement("p"); excerpt.textContent = item.excerpt;
    const meta = document.createElement("span"); meta.className = "publish-meta";
    meta.textContent = item.aiStatus === "safe"
      ? `AI policy check: safe wedding details · ${isPublicationFeePaid(item.tenant) ? "auto-publishing after publication fee" : "waiting for publication fee"}`
      : item.aiStatus === "review" ? "Safety check: human review required · original content withheld from public preview"
      : `Submitted by ${item.by} · awaiting explicit Client approval`;
    card.append(head, buttons, excerpt, meta); all.append(card);
  });
}

function renderTasks() {
  const container = document.querySelector("#committee-task-list");
  container.replaceChildren();
  tasks.filter(task => task.tenant === currentTenant).forEach(task => {
    const row = document.createElement("article"); row.className = "committee-task";
    const detail = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = task.title;
    const owner = document.createElement("small"); owner.textContent = `${task.owner} · ${task.due}`;
    detail.append(title, owner);
    const tag = document.createElement("span"); tag.className = "task-tag"; tag.textContent = "OPEN";
    row.append(detail, tag); container.append(row);
  });
}
function renderMinutes() {
  const container = document.querySelector("#minutes-list");
  container.replaceChildren();
  minutes.filter(record => record.tenant === currentTenant).forEach(record => {
    const row = document.createElement("article"); row.className = "minute-record";
    const body = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = `${record.committee} · ${record.date}`;
    const meta = document.createElement("small"); meta.textContent = `${record.category} · Follow-up: ${record.owner || "committee"}`;
    const notes = document.createElement("p"); notes.textContent = record.decision ? `${record.notes} Decision: ${record.decision}` : record.notes;
    body.append(title, meta, notes);
    const tag = document.createElement("span"); tag.className = "minutes-tag"; tag.textContent = "INTERNAL";
    row.append(body, tag); container.append(row);
  });
}
function renderMembers() {
  const container = document.querySelector("#member-list");
  container.replaceChildren();
  members.filter(member => member.tenant === currentTenant).forEach(member => {
    const row = document.createElement("div"); row.className = "member-row";
    const avatar = document.createElement("span"); avatar.className = "member-avatar"; avatar.textContent = member.initials;
    const name = document.createElement("span"); name.className = "member-name";
    const fullName = document.createElement("b"); fullName.textContent = member.name;
    const email = document.createElement("small"); email.textContent = member.email;
    name.append(fullName, email);
    const role = document.createElement("span"); role.className = "member-role";
    const select = document.createElement("select"); select.setAttribute("aria-label", `Role for ${member.name}`);
    assignableRoles(member).forEach(value => {
      const option = document.createElement("option"); option.value = value; option.textContent = value; option.selected = value === member.role; select.append(option);
    });
    select.disabled = !canManageMember(member) || assignableRoles(member).length < 2;
    select.addEventListener("change", () => {
      if (!canManageMember(member) || !assignableRoles(member).includes(select.value)) {
        select.value = member.role; notify("That role change is not allowed."); return;
      }
      member.role = select.value;
          logActivity("Workspace role changed", `${member.name} · ${member.role}`);
      renderMembers(); notify("Role updated in this browser-only demo.");
    });
    role.append(select);
    const action = document.createElement("button");
    action.className = "member-remove"; action.type = "button"; action.textContent = "Remove";
    action.disabled = !canManageMember(member);
    action.title = action.disabled ? "Your role cannot remove this member" : "Remove sample member";
    action.addEventListener("click", () => {
      if (!canManageMember(member)) { notify("You do not have permission to remove this person."); return; }
      members = members.filter(candidate => candidate !== member);
      logActivity("Member removed", `${member.name} · demo membership`);
      renderMembers(); notify("Member removed in this local demo only.");
    });
    row.append(avatar, name, role, action); container.append(row);
  });
}
function renderTenant() {
  const tenant = tenants[currentTenant];
  weddingSettings = getWeddingSettings(currentTenant);
  document.querySelector("#budget-currency-icon").textContent = weddingSettings.currency;
  document.querySelector("#breadcrumb-tenant").textContent = tenant.label;
  document.querySelector(".tenant-domain").textContent = tenant.domain;
  document.querySelector("#event-couple").textContent = tenant.couple;
  document.querySelector("#event-location").textContent = `${new Date(`${tenant.date}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} · ${tenant.location}`;
  document.querySelector("#workspace-status").textContent = tenant.status;
  document.querySelector("#site-couple").value = tenant.couple;
  document.querySelector("#site-date").value = tenant.date;
  document.querySelector("#site-location").value = tenant.location;
  document.querySelector("#builder-preview-names").textContent = tenant.couple;
  document.querySelectorAll('a[href="client-site.html"]').forEach(link => {
    link.classList.toggle("preview-disabled", !tenant.preview);
    link.setAttribute("aria-disabled", String(!tenant.preview));
    link.title = tenant.preview ? "Open Amara & Kito sample client site" : "This sample tenant has no generated client site yet";
  });
  document.querySelectorAll('[data-action="setup"]').forEach(button => { button.hidden = currentRole === "Client"; });
  document.querySelector("#site-permission").textContent = currentRole === "Admin"
    ? "Admin draft permission · changes are retained as drafts; the Client owns final approval and publication."
    : currentRole === "SuperAdmin" ? "SuperAdmin support view · editing is disabled in this tenant."
    : "You own this wedding data and can edit it freely. Safe, non-sensitive wedding details can auto-publish after the publication fee is paid; uncertain or sensitive copy stays private for human review.";
  renderFeeSettings();
  renderWeddingSettings();
  renderQueue();
  renderTasks();
  renderMinutes();
  renderMembers();
  renderActivity();
  renderFinancePage();
}
function setRole(role, showNotice = true) {
  if (!["Client", "Admin", "SuperAdmin"].includes(role)) {
    notify("That permission preview is unavailable.");
    return;
  }
  currentRole = role;
  if (role !== "SuperAdmin" && document.querySelector("#page-platform-settings").classList.contains("active")) switchPage("overview");
  document.querySelector("#role-switcher").value = role;
  document.querySelector(".current-role-label").textContent = `${role} · permission preview`;
  document.querySelector("#site-form").querySelectorAll("input,textarea,button").forEach(control => { control.disabled = !canEditContent(); });
  document.querySelectorAll(".design-option,.section-toggles input").forEach(control => { control.disabled = !canEditContent(); });
  document.querySelectorAll("[data-ai-action],#accept-ai-suggestion").forEach(control => { control.disabled = !canEditContent(); });
  document.querySelectorAll('[data-action="invite"]').forEach(button => { button.disabled = !canManagePeople(); });
  document.querySelectorAll("[data-superadmin-only]").forEach(control => { control.hidden = role !== "SuperAdmin"; });
  renderMembers();
  renderQueue();
  renderTenant();
  const descriptions = {
    Client: "Client preview: owns this wedding tenant and alone gives final approval for guest-facing site publication.",
    Admin: "Admin preview: can coordinate assigned tenant work and prepare drafts; cannot approve publication or change platform roles.",
    SuperAdmin: "SuperAdmin preview: can manage platform accounts and support tenants; cannot publish client content or access private client wedding data."
  };
  document.querySelector(".profile-button .avatar").textContent = role === "Client" ? "AK" : role === "Admin" ? "WM" : "NO";
  document.querySelector(".profile-button b").textContent = role === "Client" ? "Amara Njeri" : role === "Admin" ? "Wanjiku M." : "Noah Otieno";
  if (showNotice) notify(descriptions[role]);
}
function switchPage(page) {
  document.querySelectorAll(".page-view").forEach(view => { view.hidden = view.id !== `page-${page}`; view.classList.toggle("active", !view.hidden); });
  document.querySelectorAll(".side-link").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  if (page === "people") renderMembers();
  if (page === "publish") renderQueue();
  if (page === "finance") renderFinancePage();
  document.querySelector("#workspace-main").scrollIntoView({ block: "start" });
}

function showDialog(title, description, fields, onSubmit, actionLabel = "Save in this demo") {
  dialogContent.replaceChildren();
  const heading = document.createElement("h2"); heading.textContent = title;
  const intro = document.createElement("p"); intro.textContent = description;
  dialogContent.append(heading, intro);
  const form = document.createElement("form"); form.className = "modal-fields";
  fields.forEach(field => {
    const label = document.createElement("label"); label.textContent = field.label;
    const input = document.createElement(field.options ? "select" : field.multiline ? "textarea" : "input");
    input.name = field.name; input.required = Boolean(field.required);
    if (field.value) input.value = field.value;
    if (field.type) input.type = field.type;
    if (field.maxLength) input.maxLength = field.maxLength;
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.options) field.options.forEach(value => { const option = document.createElement("option"); option.value = value; option.textContent = value; input.append(option); });
    label.append(input); form.append(label);
  });
  const submit = document.createElement("button"); submit.className = "button button-primary"; submit.type = "submit"; submit.textContent = actionLabel;
  form.append(submit);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    onSubmit(values);
    dialog.close();
  });
  dialogContent.append(form); dialog.showModal();
}

document.querySelectorAll(".side-link").forEach(button => button.addEventListener("click", () => switchPage(button.dataset.page)));
document.addEventListener("click", event => {
  const pageButton = event.target.closest("[data-go]");
  if (pageButton) switchPage(pageButton.dataset.go);
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === "setup") {
    if (currentRole === "Client") { notify("Clients can manage their own wedding workspace, not create platform tenants."); return; }
    showDialog("Set up a client wedding", "Create an illustrative tenant. No account or site is created on a server.", [
      { name: "couple", label: "Couple names", placeholder: "e.g. Amina & James", required: true, maxLength: 100 },
      { name: "location", label: "City or region", placeholder: "e.g. Nairobi, Kenya", required: true, maxLength: 80 },
      { name: "date", label: "Wedding date", type: "date", required: true }
    ], values => {
      newTenantCounter += 1;
      const id = `new${newTenantCounter}`;
      const first = values.couple.split("&")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) || Number.isNaN(new Date(`${values.date}T12:00:00`).getTime())) { notify("Choose a valid wedding date."); return; }
      tenants[id] = { label: values.couple, couple: values.couple, date: values.date, location: values.location, domain: `${first}.weddingsite.demo`, status: "SETUP IN PROGRESS", preview: false };
      const option = document.createElement("option"); option.value = id; option.textContent = values.couple;
      document.querySelector("#tenant-select").append(option);
      document.querySelector("#tenant-select").value = id; currentTenant = id; renderTenant();
      logActivity("Sample client tenant created", `${values.couple} · local demo only`);
      notify("Demo workspace added in memory. No client account or public site was created.");
    }, "Create demo workspace");
  } else if (action === "new-note") {
    switchPage("committee");
    document.querySelector("#minutes-form [name=notes]").focus();
    notify("Add notes in the Secretary’s desk. Nothing is submitted to a service.");
  } else if (action === "invite") {
    if (!canManagePeople()) { notify("Your current role cannot invite members."); return; }
    showDialog("Invite a committee member", "This demo adds a sample member to this browser session only; it sends no invitation.", [
      { name: "name", label: "Name", placeholder: "Committee member", required: true, maxLength: 80 },
      { name: "email", label: "Email", type: "email", placeholder: "name@example.com", required: true, maxLength: 120 },
      { name: "role", label: "Workspace role", required: true, options: currentRole === "SuperAdmin" ? ["Client", "Admin"] : currentRole === "Admin" ? ["Client"] : ["Client", "Admin"] }
    ], values => {
      if (!["Client", "Admin"].includes(values.role) || (currentRole === "Admin" && values.role !== "Client")) { notify("That workspace role cannot be assigned from the invitation form."); return; }
      members.push({ name: values.name, email: values.email, role: values.role, tenant: currentTenant, initials: values.name.split(/\s+/).slice(0, 2).map(part => part[0].toUpperCase()).join("") });
      renderMembers(); logActivity("Committee invitation drafted", `${values.name} · no email sent`);
      notify("Sample member added. No invitation email was sent.");
    }, "Add sample member");
  } else if (action === "help") {
    showDialog("WeddingSite product demo", "The workspace and client invitation are separate experiences. Sample changes live only in this browser session. Preview permissions as each role, review a committee suggestion, or open the generated client site.", [], () => {}, "Close");
  } else if (action === "profile") {
    switchPage("people");
    notify("Profile controls are illustrative. No sign-in or account settings are connected.");
  }
});
document.querySelector("#tenant-select").addEventListener("change", event => {
  currentTenant = event.target.value;
  window.WeddingSiteFX.choose(getWeddingSettings(currentTenant).currency);
  renderTenant();
  if (!tenants[currentTenant].preview) notify("This sample tenant has no generated client site yet; its setup view is illustrative.");
});
document.querySelector("#role-switcher").addEventListener("change", event => setRole(event.target.value));
document.querySelector("#wedding-settings-form").addEventListener("input", event => {
  event.currentTarget.dataset.dirty = "true";
  updateDietaryBudgetImpact();
});
document.querySelector("#wedding-settings-form").addEventListener("change", event => {
  event.currentTarget.dataset.dirty = "true";
  updateDietaryBudgetImpact();
});
document.querySelector("#wedding-settings-form").addEventListener("submit", event => {
  event.preventDefault();
  if (currentRole !== "Client") { notify("Only the Client can set wedding currency, guest capacity, upgrades and fundraising streams."); return; }
  const form = event.currentTarget;
  const values = new FormData(form);
  const currency = String(values.get("currency"));
  const capacity = Number(values.get("capacity"));
  const dietaryCost = Number(values.get("dietaryCost"));
  if (!window.WeddingSiteFX.options.includes(currency) || !Number.isInteger(capacity) || capacity < 1 || capacity > 5000 ||
      !Number.isFinite(dietaryCost) || dietaryCost < 0 || dietaryCost > 100000) {
    notify("Choose a supported wedding currency, capacity from 1 to 5,000, and a non-negative accommodation budget.");
    return;
  }
  const dietaryCostUsd = window.WeddingSiteFX.convertToUsd(dietaryCost, currency);
  if (dietaryCostUsd === null) {
    notify(`The ${currency} exchange rate is unavailable. Keep the currency at USD or retry after the published rate loads.`);
    return;
  }
  const palette = [1, 2, 3, 4]
    .filter(index => values.get(`paletteEnabled${index}`) === "on")
    .map(index => String(values.get(`palette${index}`)));
  if (!palette.length || !palette.every(color => /^#[0-9a-f]{6}$/i.test(color))) { notify("Choose at least one valid wedding palette color (maximum four)."); return; }
  const lines = String(values.get("streams")).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 10) { notify("Configure between 1 and 10 optional fundraising streams."); return; }
  const streams = [];
  for (const line of lines) {
    const [rawName, rawPurpose, rawGoal, ...extra] = line.split("|").map(value => value.trim());
    const goal = Number(rawGoal);
    const goalUsd = window.WeddingSiteFX.convertToUsd(goal, currency);
    if (extra.length || !rawName || rawName.length > 50 || !rawPurpose || rawPurpose.length > 120 ||
        !Number.isFinite(goal) || goal <= 0 || goal > 10000000 || goalUsd === null) {
      notify("Each fundraiser line must contain a name, purpose and positive goal in the selected wedding currency.");
      return;
    }
    const previous = weddingSettings.streams.find(stream => stream.name.toLowerCase() === rawName.toLowerCase());
    streams.push({ name: rawName, purpose: rawPurpose, goalUsd, raisedUsd: previous?.raisedUsd || 0 });
  }
  const nextSettings = { currency, capacity, dietaryCostUsd, palette, streams };
  try {
    const stored = JSON.parse(localStorage.getItem(weddingSettingsKey) || "null");
    const tenants = stored?.tenants && typeof stored.tenants === "object" ? stored.tenants : {};
    tenants[currentTenant] = nextSettings;
    localStorage.setItem(weddingSettingsKey, JSON.stringify({ tenants }));
    weddingSettingsByTenant = tenants;
    weddingSettings = nextSettings;
    window.WeddingSiteFX.choose(currency);
    renderTenant();
    logActivity("Wedding experience settings updated", `${currency} · capacity ${capacity} · ${streams.length} optional fundraising streams`);
    notify("Wedding experience settings saved in this browser demo. No guest records, funds or live site were changed.");
  } catch {
    notify("Could not save the wedding settings in browser storage. No public settings were changed.");
  }
});
document.querySelector("#display-currency").addEventListener("change", event => {
  window.WeddingSiteFX.choose(event.target.value);
  renderFeeSettings();
});
document.addEventListener("weddingsitefxchange", event => {
  const { currency } = event.detail;
  const status = window.WeddingSiteFX.statusText();
  document.querySelectorAll(".fx-status").forEach(element => {
    element.textContent = status;
    element.dataset.state = status.includes("STALE") || status.includes("unavailable") ? "stale" : "";
  });
  document.querySelector("#display-currency").value = currency;
  renderFeeSettings();
  const weddingForm = document.querySelector("#wedding-settings-form");
  if (weddingForm.dataset.dirty !== "true") renderWeddingSettings();
  else updateDietaryBudgetImpact();
  renderPrivateFundraisingBreakdown();
});
document.querySelector("#fee-settings-form").addEventListener("submit", event => {
  event.preventDefault();
  if (currentRole !== "SuperAdmin") { notify("Only a SuperAdmin can change platform fee settings."); return; }
  const values = new FormData(event.currentTarget);
  const publicationFee = Number(values.get("publicationFee"));
  const contributionFee = Number(values.get("contributionFee"));
  if (!Number.isFinite(publicationFee) || publicationFee < 0 || publicationFee > 1000000 || !Number.isFinite(contributionFee) || contributionFee < 0 || contributionFee > 100) {
    notify("Enter a valid publication fee and a contribution fee between 0% and 100%."); return;
  }
  try {
    const currency = String(values.get("currency"));
    const locale = String(values.get("locale"));
    const market = String(values.get("market")).trim();
    const paymentMethods = String(values.get("paymentMethods")).trim();
    if (!window.WeddingSiteFX.options.includes(currency) || !market || market.length > 60 || !paymentMethods || paymentMethods.length > 120) {
      notify("Choose a supported currency and enter valid market and payment-method labels."); return;
    }
    feeConfig = { publicationFee, contributionFee, currency, locale, market, paymentMethods };
    localStorage.setItem(feeConfigKey, JSON.stringify(feeConfig));
    window.WeddingSiteFX.choose(currency);
    renderFeeSettings();
    renderTenant();
    logActivity("Platform fee policy updated", `${formatUsd(publicationFee)} publication fee · ${contributionFee}% contribution fee`);
    notify("Demo fee policy saved on this browser. No real charge or payment-provider update occurred.");
  } catch {
    notify("Could not save the demo fee policy. The public contribution estimate was not changed.");
  }
});
function addFinanceAudit(action, record) {
  financeSampleAudit.unshift({
    actor: `${currentRole} · demo`,
    action,
    record,
    time: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  });
  renderFinancePage();
  logActivity(action, `${record} · illustrative record only`);
}
document.querySelector("#finance-expense-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!["Client", "Admin"].includes(currentRole)) { notify("Only the Client or assigned Admin can add a proposed expense."); return; }
  const values = new FormData(event.currentTarget);
  const amount = Number(values.get("amount"));
  const amountUsd = window.WeddingSiteFX.convertToUsd(amount, weddingSettings.currency);
  const category = String(values.get("category")).trim();
  const description = String(values.get("description")).trim();
  if (!category || category.length > 80 || !description || description.length > 120 || !Number.isFinite(amount) || amount <= 0 || amountUsd === null) {
    notify("Enter a valid proposed expense and ensure the selected wedding-currency FX rate is available. Nothing was recorded.");
    return;
  }
  const due = String(values.get("dueOn") || "");
  financeSampleExpenses.unshift({
    category, description, amountUsd, status: "Proposed",
    due: due ? new Date(`${due}T12:00:00`).toLocaleDateString("en-GB") : "Not set"
  });
  event.currentTarget.reset();
  addFinanceAudit("Expense proposal added", `${category} · ${formatUsd(amountUsd)}`);
  notify("Proposed expense added to this browser demo. No money was moved or marked paid.");
});
document.querySelector("#finance-reconcile-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!["Client", "Admin"].includes(currentRole)) { notify("Your current role cannot submit reconciliation evidence."); return; }
  const values = new FormData(event.currentTarget);
  const expected = Number(values.get("expected"));
  const reported = Number(values.get("reported"));
  const expectedUsd = window.WeddingSiteFX.convertToUsd(expected, weddingSettings.currency);
  const reportedUsd = window.WeddingSiteFX.convertToUsd(reported, weddingSettings.currency);
  const provider = String(values.get("provider")).trim();
  const reference = String(values.get("reference")).trim();
  if (!provider || provider.length > 60 || !reference || reference.length > 120 ||
      !Number.isFinite(expected) || !Number.isFinite(reported) || expectedUsd === null || reportedUsd === null) {
    notify("Enter safe reference text and valid amounts. Do not enter account numbers or credentials.");
    return;
  }
  financeSampleReconciliations.unshift({
    reference: `${provider} · ${reference}`, expectedUsd, reportedUsd, status: "Pending review",
    date: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  });
  event.currentTarget.reset();
  addFinanceAudit("Reconciliation evidence submitted", reference);
  notify("Reconciliation is pending human review. No contribution or payment status was changed.");
});
document.querySelector("#finance-budget-form").addEventListener("submit", event => {
  event.preventDefault();
  if (currentRole !== "Client") { notify("Only the Client can change wedding budget estimates."); return; }
  const values = new FormData(event.currentTarget);
  const planned = Number(values.get("planned"));
  const actual = Number(values.get("actual"));
  const plannedUsd = window.WeddingSiteFX.convertToUsd(planned, weddingSettings.currency);
  const actualUsd = window.WeddingSiteFX.convertToUsd(actual, weddingSettings.currency);
  const category = String(values.get("category")).trim();
  if (!category || category.length > 80 || !Number.isFinite(planned) || planned < 0 ||
      !Number.isFinite(actual) || actual < 0 || plannedUsd === null || actualUsd === null) {
    notify("Enter valid non-negative budget amounts and ensure the selected currency rate is available.");
    return;
  }
  financeSampleBudget.plannedUsd = plannedUsd;
  financeSampleBudget.actualUsd = actualUsd;
  event.currentTarget.reset();
  addFinanceAudit("Budget estimate updated", `${category} · estimate only`);
  notify("Budget estimate updated in this browser demo; actual is not verified proof of payment.");
});
document.querySelector("#finance-payout-request").addEventListener("click", () => {
  if (currentRole !== "Client") { notify("Only the Client may request a payout record."); return; }
  showDialog("Request a payout record?", "This creates an unsubmitted demo request only. It will not send money, reveal account details, or mark a payout as sent. A real payout would require a separately authorized provider action and explicit confirmation.", [
    { name: "amount", label: `Requested amount (${weddingSettings.currency})`, type: "number", required: true, placeholder: "0.00" },
    { name: "note", label: "Private note (no bank details)", maxLength: 120, placeholder: "Optional reason for the request" }
  ], values => {
    const amount = Number(values.amount);
    const amountUsd = window.WeddingSiteFX.convertToUsd(amount, weddingSettings.currency);
    if (!Number.isFinite(amount) || amount <= 0 || amountUsd === null) {
      notify("Enter a valid amount and ensure the selected-currency FX rate is available. No request was recorded.");
      return;
    }
    financeSamplePayouts.unshift({
      amountUsd, status: "Requested · not sent",
      requested: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    });
    addFinanceAudit("Payout request created · not sent", formatUsd(amountUsd));
    notify("Demo payout request created. No transfer was initiated.");
  }, "Create demo request only");
});
document.querySelector("#finance-export").addEventListener("click", () => {
  const rows = currentRole === "SuperAdmin"
    ? [["record_type", "amount_usd", "status"], ["publication_fee_demo", "75.00", "illustrative"], ["platform_fee_demo", "41.00", "illustrative"]]
    : [
      ["record_type", "category_or_stream", "pledged_usd", "paid_usd", "fee_usd", "status"],
      ...financeSampleContributions.map(item => ["contribution", item.stream, item.pledgedUsd.toFixed(2), item.paidUsd.toFixed(2), (Math.round(item.paidUsd * feeConfig.contributionFee) / 100).toFixed(2), item.status]),
      ...financeSampleExpenses.map(item => ["expense", item.category, "", item.amountUsd.toFixed(2), "", item.status]),
      ...financeSamplePayouts.map(item => ["payout_record", "private client workspace", "", item.amountUsd.toFixed(2), "", item.status])
    ];
  const csvValue = value => {
    const text = String(value ?? "");
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const csv = rows.map(row => row.map(csvValue).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `weddingsite-demo-finance-${currentTenant}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("Illustrative finance CSV exported. It contains no guest names, account details or provider credentials.");
});
document.querySelector("#pay-publication-fee").addEventListener("click", () => {
  if (currentRole !== "Client" || isPublicationFeePaid()) return;
  showDialog("Simulate publication-fee payment?", `The one-time fee is ${formatUsd(feeConfig.publicationFee)}. USD is the canonical price; any shown conversion is indicative. This records a local demo payment only; no payment is collected. After confirmation, safe wedding details may auto-publish under the demo safety policy.`, [], () => {
    try {
      publicationPayments[currentTenant] = feeConfig.publicationFee;
      localStorage.setItem(paidSitesKey, JSON.stringify(publicationPayments));
      renderTenant();
      publishSafeDraftsAfterPayment(currentTenant);
      logActivity("Publication fee marked paid in demo", `${tenants[currentTenant].label} · ${formatUsd(feeConfig.publicationFee)} · simulated only`);
      notify("Demo fee marked paid. Safe approved wedding details can now publish in this browser.");
    } catch {
      notify("Could not record the demo fee status; the site remains unpublished.");
    }
  }, "Confirm demo payment");
});

document.querySelector("#site-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!canEditContent()) { notify("Your current role is read-only for wedding content."); return; }
  const values = new FormData(event.currentTarget);
  const couple = String(values.get("couple")).trim();
  const location = String(values.get("location")).trim();
  const date = String(values.get("date"));
  const story = String(values.get("story")).trim();
  const eventDate = new Date(`${date}T12:00:00`);
  if (!couple || couple.length > 100 || !location || location.length > 80 || Number.isNaN(eventDate.getTime()) || eventDate.toISOString().slice(0, 10) !== date) {
    notify("Enter valid couple names, wedding date and location. Your draft was not saved."); return;
  }
  document.querySelector("#builder-preview-names").textContent = couple;
  document.querySelector("#event-couple").textContent = couple;
  document.querySelector("#event-location").textContent = `${eventDate.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} · ${location}`;
  const tenant = currentTenant;
  tenants[tenant].couple = couple; tenants[tenant].date = date; tenants[tenant].location = location; tenants[tenant].label = couple.split("&")[0].trim();
  tenants[tenant].domain = `${couple.split("&")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}.weddingsite.demo`;
  const siteConfig = { couple, location, date, story };
  const sensitive = hasSensitiveSiteContent(`${couple} ${location} ${story}`);
  const isClientOwned = currentRole === "Client";
  const safeSiteInfo = isClientOwned && !sensitive;
  const item = {
    id: Date.now(), type: "SITE DETAILS", title: sensitive ? "Wedding-site edit held for human review" : "Updated wedding details",
    excerpt: sensitive ? "The local safety check flagged this edit. The private draft is withheld from the guest site until the Client rewrites it as safe public copy." : `${couple} · ${location} · ${date}.`,
    by: `${currentRole} · locally checked demo`, state: "pending", tenant,
    aiStatus: sensitive ? "review" : safeSiteInfo ? "safe" : "client-review",
    siteConfig: !sensitive ? siteConfig : undefined,
    privateSiteConfig: siteConfig, privateStory: story
  };
  queue.unshift(item);
  if (safeSiteInfo && !sensitive && isPublicationFeePaid(tenant)) {
    try {
      saveApprovedPreview(item);
      item.state = "approved";
      logActivity("Safe wedding details auto-published", `${couple} · local policy demo; no AI service connected.`);
      renderTenant(); renderQueue();
      notify("Your wedding details passed the demo safety check and were auto-approved to this browser's preview. No AI service or real publisher is connected.");
      return;
    } catch {
      item.state = "pending";
      notify("Your edits were saved in this browser, but the approved client preview could not be updated.");
    }
  } else if (safeSiteInfo && !sensitive) {
    item.aiStatus = "safe";
  }
  renderTenant();
  logActivity("Wedding-site draft saved", `${currentRole} · ${sensitive ? "held for human review" : isClientOwned ? "safe details awaiting publication fee" : "Client review required"}`);
  renderQueue();
  notify(sensitive
    ? "Draft saved privately. The local safety check flagged it for human review; no public copy was changed."
    : isClientOwned
      ? isPublicationFeePaid(tenant) ? "Your draft is saved. Client review is required before these updates can be published." : "Your wedding data is saved and editable. Pay the one-time publication fee before this safe edit can auto-publish."
      : "Admin draft saved. The Client must review and approve it before publication.");
});
document.querySelectorAll(".design-option").forEach(button => button.addEventListener("click", () => {
  if (!canEditContent()) { notify("Your current role cannot change site styling."); return; }
  document.querySelectorAll(".design-option").forEach(item => item.classList.toggle("selected", item === button));
  const hero = document.querySelector(".design-hero");
  hero.dataset.theme = button.dataset.theme;
  logActivity("Site design preview changed", `${button.textContent.trim()} · local-only preview`);
}));
document.querySelector("#site-date").addEventListener("input", event => {
  const date = new Date(`${event.target.value}T12:00:00`);
  if (!Number.isNaN(date.getTime())) document.querySelector(".design-preview-date").textContent = date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toUpperCase();
});
document.querySelector("#site-couple").addEventListener("input", event => {
  document.querySelector("#builder-preview-names").textContent = event.target.value;
});
let aiSuggestionTarget = "story";
document.querySelectorAll("[data-ai-action]").forEach(button => button.addEventListener("click", () => {
  const couple = document.querySelector("#site-couple").value.trim() || "the couple";
  const location = document.querySelector("#site-location").value.trim() || "your region";
  const currentStory = document.querySelector("#site-story").value.trim();
  const suggestions = {
    draft: { target: "story", text: `We are ${couple}, and we're so glad to celebrate this next chapter with the people we love. Join us in ${location} for a day of family, joy and dancing.` },
    polish: { target: "story", text: currentStory ? `${currentStory.replace(/[.!?]+$/, "")}. We can't wait to celebrate this special day with the people we love.` : `We can't wait to celebrate this special day with the people we love in ${location}.` },
    venue: { target: "notes", text: `Venue shortlist prompt (unverified suggestion): compare 2–3 local venues in ${location} for guest capacity, accessibility, transport, weather backup, availability and written pricing. Confirm every detail directly with each venue.` },
    attire: { target: "notes", text: "Attire inspiration (suggestion, not a rule): consider formal African elegance with forest green, eucalyptus sage and warm gold accents; invite guests to prioritize comfort and avoid presenting palette inspiration as a strict requirement." },
    next: { target: "notes", text: "Suggested next steps (verify with your team): confirm the ceremony venue and rain plan, assign a guest transport lead, reconcile the latest budget against provider statements, then ask the Client to review any guest-facing copy." }
  };
  const suggestion = suggestions[button.dataset.aiAction];
  aiSuggestionTarget = suggestion.target;
  document.querySelector("#ai-suggestion").value = suggestion.text;
  document.querySelector("#accept-ai-suggestion").disabled = !canEditContent();
}));
document.querySelector("#accept-ai-suggestion").addEventListener("click", () => {
  if (!canEditContent()) { notify("Your current role cannot accept wedding-site suggestions."); return; }
  const suggestion = document.querySelector("#ai-suggestion").value.trim();
  if (!suggestion) { notify("Add or edit the suggestion before accepting it."); return; }
  if (aiSuggestionTarget === "story") {
    document.querySelector("#site-story").value = suggestion;
    document.querySelector("#site-story").focus();
    notify("Suggestion added to your editable welcome note. Review it and save whenever you choose.");
  } else {
    switchPage("committee");
    const notes = document.querySelector("#minutes-form [name=notes]");
    notes.value = [notes.value, suggestion].filter(Boolean).join("\n\n");
    notes.focus();
    notify("Suggestion added as an editable internal planning note. It is not a verified fact or public update.");
  }
});
document.querySelectorAll(".section-toggles input").forEach(toggle => toggle.addEventListener("change", () => notify(`${toggle.closest("label").querySelector("b").textContent} ${toggle.checked ? "included" : "hidden"} in the local draft preview.`)));

document.querySelector("#minutes-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!["Client", "Admin"].includes(currentRole)) { notify("This role is read-only for committee records."); return; }
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const record = {
    date: new Date(`${values.date}T12:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase(),
    committee: values.committee, notes: values.notes, decision: values.decision, owner: values.owner || "Committee", category: values.category, tenant: currentTenant
  };
  minutes.unshift(record);
  if (values.owner || values.due) tasks.unshift({ title: values.decision || values.notes.slice(0, 85), owner: `${values.committee} · ${values.owner || "Unassigned"}`, due: values.due ? `Due ${values.due}` : "No due date", tenant: currentTenant });
  const safeForSite = values.publishRequest && values.category !== "budget" && values.category !== "guest" && (values.decision || values.notes);
  if (safeForSite) queue.unshift({ id: Date.now(), type: values.category === "program" ? "PROGRAM UPDATE" : "COMMITTEE UPDATE", title: values.decision ? values.decision.slice(0, 85) : "Committee guest-site update", excerpt: values.decision || values.notes.slice(0, 220), by: `${values.committee} · ${currentRole}`, state: "pending", tenant: currentTenant });
  renderMinutes(); renderTasks(); renderQueue();
  logActivity("Committee record captured", `${values.committee} · internal notes`);
  event.currentTarget.reset();
  notify(safeForSite ? "Minutes recorded internally; a separate guest-facing draft awaits Client review." : values.category === "budget" ? "Internal finance note recorded. Financial claims require independent reconciliation and are never published automatically." : "Committee minutes saved internally only. Private notes were not sent to the guest site.");
});

document.querySelector("#tenant-select").value = currentTenant;
weddingSettings = getWeddingSettings(currentTenant);
window.WeddingSiteFX.choose(weddingSettings.currency);
renderTenant(); renderMinutes(); renderTasks(); renderMembers(); renderActivity(); renderQueue(); setRole(currentRole, false);
