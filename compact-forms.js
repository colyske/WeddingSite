(function () {
  const message = "Use the designated contact fields for phone numbers and email addresses.";
  function validate(input) {
    if (!input.matches("input, textarea")) return;
    const type = input.type || "text";
    const designated = !["text", "textarea"].includes(type) ||
      /phone|email|password|lookup|pass-code|token|id-number|currency|hex|search|referral|ref-code/i.test(input.id + " " + input.name) ||
      input.hasAttribute("data-contact-allowed");
    const invalid = !designated && window.WSContactPolicy?.hasContact(input.value);
    if (invalid) {
      input.dataset.contactInvalid = "true";
      input.setCustomValidity(message);
      input.setAttribute("aria-invalid", "true");
    } else if (input.dataset.contactInvalid) {
      delete input.dataset.contactInvalid;
      input.setCustomValidity("");
      input.removeAttribute("aria-invalid");
    }
  }
  document.addEventListener("input", event => validate(event.target));
  document.addEventListener("submit", event => {
    const inputs = [...event.target.querySelectorAll("input, textarea")];
    inputs.forEach(validate);
    const invalid = inputs.find(input => input.dataset.contactInvalid);
    if (invalid) {
      event.preventDefault();
      event.stopImmediatePropagation();
      invalid.reportValidity();
      invalid.focus();
    }
  }, true);
  function compact() {
    if (document.body.dataset.showcase) {
      document.querySelectorAll("form input, form select, form textarea, form button, [data-buy], [data-song-bid], #sponsor-cta").forEach(control => {
        if (!control.disabled) control.disabled = true;
      });
    }
    document.querySelectorAll("form label[for]").forEach(label => {
      const input = document.getElementById(label.htmlFor);
      if (!input || input.type === "checkbox" || input.type === "radio" ||
          input.parentElement !== label.parentElement || label.closest(".field-row")) return;
      if (label.nextElementSibling !== input) return;
      const row = document.createElement("div");
      row.className = "field-row";
      label.before(row);
      row.append(label, input);
    });
    document.querySelectorAll("form label:not(.field-row)").forEach(label => {
      if (label.closest(".field-row")) return;
      const inputs = label.querySelectorAll(":scope > input, :scope > select, :scope > textarea");
      if (inputs.length !== 1 || ["checkbox", "radio"].includes(inputs[0].type)) return;
      const input = inputs[0];
      const caption = document.createElement("span");
      [...label.childNodes].filter(node => node !== input).forEach(node => caption.append(node));
      label.prepend(caption);
      label.classList.add("field-row");
    });
  }
  compact();
  new MutationObserver(compact).observe(document.body, { childList: true, subtree: true });
})();
