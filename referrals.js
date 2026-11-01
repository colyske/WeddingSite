(async function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const notice = text => { $("referral-notice").textContent = text; };
  if (!WS.token()) {
    location.replace("/signin.html?next=" + encodeURIComponent("/referrals.html"));
    return;
  }
  async function load() {
    const summary = await WSReferrals.request("summary");
    const account = summary.account;
    $("referral-account").hidden = !account;
    $("referral-consent-form").hidden = account?.opted_in === true;
    if (account) {
      $("referral-consent-status").textContent = `${account.opted_in ? "Opted in" : "Withdrawn"}; consent recorded ${account.consent_at}, terms ${account.terms_version}.`;
      $("referral-link").value = account.opted_in ? `${location.origin}/dashboard.html?client_ref=${account.code}` : "";
      $("referral-copy").disabled = !account.opted_in;
      $("referral-withdraw").disabled = !account.opted_in;
    }
    $("referral-count").textContent = `${summary.referral_count} wedding referral(s). Payable: zero.`;
    $("referral-results").replaceChildren(...summary.weddings.map(row => {
      const p = document.createElement("p");
      const eligibility = row.excluded_by_account_link ? "ineligible (provable owner/client account link)" :
        row.eligible ? "eligible for prospective estimates" : "ineligible (created before program activation)";
      p.textContent = `Reference ${row.reference}: ${eligibility}. ` +
        (row.currency ? `Verified net basis ${WSReferrals.money(row.verified_basis_minor, row.currency)}; HELD estimate ${WSReferrals.money(row.held_estimate_minor, row.currency)}; payable ${WSReferrals.money("0", row.currency)}.` : "No contributions recorded.");
      return p;
    }));
  }
  $("referral-consent-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!$("referral-consent").checked) return;
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await WSReferrals.request("consent", { optedIn: true, termsVersion: "client-referrals-v1" });
      await load();
      notice("Opt-in consent recorded. Estimates remain held; nothing is payable.");
    } catch (error) { notice(error.message); }
    finally { button.disabled = false; }
  });
  $("referral-withdraw").addEventListener("click", async () => {
    $("referral-withdraw").disabled = true;
    try {
      await WSReferrals.request("consent", { optedIn: false, termsVersion: "client-referrals-v1" });
      await load();
      notice("Opt-in withdrawn. New captures and new estimates are disabled; historical attribution and consent records remain.");
    } catch (error) { notice(error.message); $("referral-withdraw").disabled = false; }
  });
  $("referral-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("referral-link").value); notice("Referral link copied."); }
    catch { notice("The clipboard is unavailable. Select and copy the link above."); }
  });
  try { await load(); } catch (error) { notice(error.message); }
})();
