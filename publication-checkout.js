(function () {
  const weddingId = new URLSearchParams(location.search).get("id");
  const trigger = document.getElementById("pay-fee-btn");
  if (!trigger || !weddingId) return;
  const dialog = document.createElement("dialog");
  dialog.id = "publication-dialog";
  dialog.setAttribute("aria-labelledby", "publication-title");
  dialog.innerHTML = `<form id="publication-form">
    <h2 id="publication-title">Publication fee — test mode</h2>
    <p>This checkout pays the platform, not the wedding fund. Test confirmation is not real collected revenue. Publishing still requires your separate confirmation.</p>
    <p id="publication-quote" role="status"></p>
    <label for="publication-method">Payment method</label><select id="publication-method"></select>
    <label for="publication-email">Payment email</label><input id="publication-email" type="email" autocomplete="email" maxlength="254">
    <label for="publication-phone">M-Pesa number</label><input id="publication-phone" type="tel" autocomplete="tel">
    <div id="publication-captcha"></div>
    <p id="publication-status" role="status" aria-live="polite"></p>
    <button id="publication-submit" type="submit" disabled>Confirm &amp; pay (test mode)</button>
    <button id="publication-check" type="button" hidden>Check existing payment</button>
    <button id="publication-reload" type="button" hidden>Reload payment options</button>
    <button id="publication-close" type="button">Close</button>
  </form>`;
  document.body.append(dialog);
  const $ = id => document.getElementById(id);
  const key = `ws-publication:${weddingId}`;
  let quote, paymentId, token = "", widget, scriptPromise, timer, checks = 0, submitting = false;
  const message = text => { $("publication-status").textContent = text; };
  async function api(action, body, id) {
    const response = await WS.api(`/api/weddings?action=publication-${action}&weddingId=${encodeURIComponent(weddingId)}${id ? "&id=" + encodeURIComponent(id) : ""}`,
      body ? { method: "POST", body: JSON.stringify({ weddingId, ...body }) } : {});
    const data = await response.json();
    if (!response.ok) {
      if (data.checkout) remember(data.checkout);
      throw new Error(data.error || "Publication payment is unavailable.");
    }
    return data;
  }
  function remember(checkout) {
    paymentId = checkout.id;
    sessionStorage.setItem(key, checkout.id);
    $("publication-submit").disabled = true;
    $("publication-check").hidden = false;
    $("publication-reload").hidden = true;
    $("publication-quote").textContent = `Existing test payment: ${WS.money(checkout.amountMinor, checkout.currency, false)}.`;
  }
  function clearPayment() {
    clearTimeout(timer);
    paymentId = null;
    sessionStorage.removeItem(key);
    $("publication-check").hidden = true;
    $("publication-reload").hidden = false;
  }
  async function check() {
    clearTimeout(timer);
    if (!paymentId) return;
    $("publication-check").hidden = false;
    $("publication-submit").disabled = true;
    $("publication-check").disabled = true;
    try {
      const { checkout } = await api("status", null, paymentId);
      if (checkout.status === "paid") {
        clearPayment();
        $("publication-reload").hidden = true;
        message("Publication fee verified in test mode. No wedding-fund credit was created. Close this window and confirm publishing when ready.");
        document.dispatchEvent(new CustomEvent("ws:publication-verified"));
      } else if (checkout.status === "failed") {
        clearPayment();
        message(`The provider confirmed this attempt did not complete${checkout.resultCode ? " (code " + checkout.resultCode + ")" : ""}. No publication fee was settled. Reload options for a fresh attempt.`);
      } else if (checkout.status === "review") {
        message("This payment requires platform support review. Do not start another payment. Reference: " + checkout.id);
      } else {
        checks++;
        if (checks < 7 && dialog.open) {
          message("Waiting for provider confirmation. Do not start another payment.");
          timer = setTimeout(check, Math.min(3000 * 2 ** (checks - 1), 20000));
        } else message("Confirmation timed out locally; the payment is still unresolved, not cancelled. Check this existing payment again or contact support. No fresh checkout is allowed yet.");
      }
    } catch (error) { message(error.message); }
    finally { $("publication-check").disabled = false; }
  }
  async function challenge(siteKey) {
    if (!siteKey) throw new Error("Payment anti-abuse verification is not configured.");
    if (!window.turnstile) {
      scriptPromise ||= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.onload = resolve;
        script.onerror = () => reject(new Error("Could not load anti-abuse verification."));
        document.head.append(script);
      });
      await scriptPromise;
    }
    if (widget !== undefined) window.turnstile.remove(widget);
    token = "";
    $("publication-captcha").replaceChildren();
    widget = window.turnstile.render($("publication-captcha"), {
      sitekey: siteKey, callback: value => { token = value; $("publication-submit").disabled = false; },
      "expired-callback": () => { token = ""; $("publication-submit").disabled = true; },
      "error-callback": () => { token = ""; $("publication-submit").disabled = true; message("Human verification failed. Reload payment options to try the challenge again."); }
    });
  }
  async function options() {
    clearTimeout(timer);
    $("publication-submit").disabled = true;
    $("publication-reload").hidden = true;
    message("Loading the current publication quote…");
    try {
      const data = await api("options");
      quote = data.quote;
      if (data.checkout) { remember(data.checkout); checks = 0; await check(); return; }
      if (Number(quote.fee_minor) <= 0) {
        clearPayment();
        $("publication-reload").hidden = true;
        $("publication-quote").textContent = quote.reason || "No publication fee is due.";
        message("No new payment is needed. Close this window and confirm publishing when ready.");
        document.dispatchEvent(new CustomEvent("ws:publication-verified"));
        return;
      }
      $("publication-quote").textContent = `${WS.money(quote.fee_minor, quote.currency, false)}. ${quote.reason}`;
      $("publication-method").replaceChildren(...data.methods.map(method => new Option(method.label, method.id)));
      $("publication-method").dispatchEvent(new Event("change"));
      if (!data.methods.length) throw new Error("No configured test payment method is currently available. Publishing remains blocked; contact platform support.");
      message("Complete the human check before confirming this test payment.");
      await challenge(data.turnstileSiteKey);
    } catch (error) { message(error.message); $("publication-reload").hidden = false; }
  }
  $("publication-method").addEventListener("change", () => {
    const mpesa = $("publication-method").value === "mpesa";
    $("publication-phone").required = mpesa;
    $("publication-email").required = !mpesa;
    $("publication-phone").hidden = !mpesa;
    dialog.querySelector('label[for="publication-phone"]').hidden = !mpesa;
  });
  $("publication-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (submitting || paymentId) return;
    if (!token) return message("Complete the human check before payment.");
    submitting = true;
    $("publication-submit").disabled = true;
    try {
      const data = await api("create", {
        idempotencyKey: crypto.randomUUID(), confirmed: true, expectedAmountMinor: Number(quote.fee_minor),
        expectedCurrency: quote.currency, method: $("publication-method").value, captchaToken: token,
        email: $("publication-email").value, mpesaPhone: $("publication-phone").value
      });
      remember(data.checkout);
      if (data.checkoutUrl) location.assign(data.checkoutUrl);
      else { checks = 0; await check(); }
    } catch (error) {
      message(error.message);
      // Re-read server state after ambiguous network failures; never enable a blind retry.
      $("publication-reload").hidden = false;
    } finally { submitting = false; token = ""; }
  });
  $("publication-check").addEventListener("click", () => { checks = 0; check(); });
  $("publication-reload").addEventListener("click", options);
  $("publication-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { clearTimeout(timer); trigger.focus(); });
  trigger.addEventListener("click", () => { dialog.showModal(); options(); });
  const returned = new URLSearchParams(location.search).get("publicationReturn");
  if (returned) {
    paymentId = returned;
    dialog.showModal();
    check();
    const url = new URL(location.href);
    url.searchParams.delete("publicationReturn");
    history.replaceState(null, "", url);
  }
})();
