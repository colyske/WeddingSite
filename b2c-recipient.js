(function () {
  const $ = id => document.getElementById(id);
  const notice = message => { $("notice").textContent = message; };
  if (!WS.token()) { location.replace("/signin.html?next=%2Fb2c-recipient.html"); return; }
  async function request(action, body) {
    const response = await WS.api(`/api/b2c?action=${action}`, { method: "POST",
      body: JSON.stringify({ ...body, confirmed: true }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Payout action held.");
    return data;
  }
  async function context() {
    const response = await WS.api(`/api/b2c?action=recipient-context&wedding=${encodeURIComponent($("wedding").value)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Recipient information unavailable.");
    return data;
  }
  async function requestFields() {
    const values = { ...Object.fromEntries(new FormData($("request"))), weddingId: $("wedding").value };
    values.amountMinor = Number(values.amountMinor);
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
    const storageKey = "b2c-request:" + Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, "0")).join("");
    return { values, storageKey };
  }
  $("load").addEventListener("click", async () => {
    try {
      $("context").textContent = JSON.stringify(await context(), null, 2);
    } catch (error) { notice(error.message); }
  });
  $("new-request").addEventListener("click", async event => {
    event.target.disabled = true;
    try {
      const { storageKey } = await requestFields();
      const previous = sessionStorage.getItem(storageKey + ":id");
      const data = await context();
      if (!previous || !data.requests.some(r => r.id === previous && ["paid", "cancelled", "not_transferred"].includes(r.state))) {
        throw new Error("The previous request is not confirmed closed. Reuse its key; do not create a duplicate while an outcome is unknown.");
      }
      sessionStorage.setItem(storageKey, crypto.randomUUID());
      sessionStorage.removeItem(storageKey + ":id");
      notice("A distinct request key is ready. Submit only if you intend an additional payout; funds and limits will be checked again.");
    } catch (error) { notice(error.message); }
    finally { event.target.disabled = false; }
  });
  for (const action of ["phone-start", "phone-confirm", "bind", "request", "cancel"]) {
    $(action).addEventListener("submit", async event => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        let values = { ...Object.fromEntries(new FormData(event.target)), weddingId: $("wedding").value };
        let storageKey;
        if (action === "request") {
          ({ values, storageKey } = await requestFields());
          if (!sessionStorage.getItem(storageKey)) sessionStorage.setItem(storageKey, crypto.randomUUID());
          values.key = sessionStorage.getItem(storageKey);
        }
        const result = await request(action, values);
        if (storageKey && result.id) sessionStorage.setItem(storageKey + ":id", result.id);
        notice(result.message || (result.cancelled ? "Unclaimed request cancelled."
          : result.id ? `Payout requested: ${result.id}. This is not a payment confirmation.` : "Destination control bound to reviewed recipient."));
        if (action === "phone-confirm") event.target.reset();
      } catch (error) { notice(error.message); }
      finally { button.disabled = false; }
    });
  }
})();
