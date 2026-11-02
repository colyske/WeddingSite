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
  $("load").addEventListener("click", async () => {
    try {
      const response = await WS.api(`/api/b2c?action=recipient-context&wedding=${encodeURIComponent($("wedding").value)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Recipient information unavailable.");
      $("context").textContent = JSON.stringify(data, null, 2);
    } catch (error) { notice(error.message); }
  });
  for (const action of ["phone-start", "phone-confirm", "bind", "request"]) {
    $(action).addEventListener("submit", async event => {
      event.preventDefault();
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        const values = { ...Object.fromEntries(new FormData(event.target)), weddingId: $("wedding").value };
        if (action === "request") {
          values.amountMinor = Number(values.amountMinor);
          const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
          const storageKey = "b2c-request:" + Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, "0")).join("");
          if (!sessionStorage.getItem(storageKey)) sessionStorage.setItem(storageKey, crypto.randomUUID());
          values.key = sessionStorage.getItem(storageKey);
        }
        const result = await request(action, values);
        notice(result.message || (result.id ? `Payout requested: ${result.id}. This is not a payment confirmation.` : "Destination control bound to reviewed recipient."));
        if (action === "phone-confirm") event.target.reset();
      } catch (error) { notice(error.message); }
      finally { button.disabled = false; }
    });
  }
})();
