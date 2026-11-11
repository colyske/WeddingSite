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
      const referralLink = account.opted_in ? `${location.origin}/dashboard.html?client_ref=${account.code}` : "";
      $("referral-link").value = referralLink;
      $("referral-share-message").value = referralLink ? `Here's the link to set up your wedding site: ${referralLink}. Click it, sign in, and I'll help you fill everything in.` : "";
      $("referral-share-message-wrap").hidden = !account.opted_in;
      $("referral-share-copy").disabled = !account.opted_in;
      $("referral-copy").disabled = !account.opted_in;
      $("referral-withdraw").disabled = !account.opted_in;
    }
    $("referral-count").textContent = `${summary.referral_count} wedding referral(s). Commission is paid after funds are cleared.`;
    $("referral-results").replaceChildren(...summary.weddings.map(row => {
      const p = document.createElement("p");
      const eligibility = row.excluded_by_account_link ? "not eligible (account is connected to this wedding)" :
        row.eligible ? "eligible for commission tracking" : "not eligible (wedding created before program activation)";
      p.textContent = `Reference ${row.reference}: ${eligibility}. ` +
        (row.currency ? `Verified net basis ${WSReferrals.money(row.verified_basis_minor, row.currency)}; tracked 2% commission ${WSReferrals.money(row.held_estimate_minor, row.currency)}. Paid after funds are cleared.` : "No contributions recorded yet.");
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
      notice("You’re opted in. Your referral link and eligible commission activity are ready to track.");
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
  $("referral-share-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("referral-share-message").value);
      notice("Setup message copied. Send it after the couple has agreed.");
    } catch { notice("Clipboard unavailable. Select and copy the setup message above."); }
  });
  try { await load(); } catch (error) { notice(error.message); }
})();
