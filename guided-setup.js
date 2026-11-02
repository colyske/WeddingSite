(function (global) {
  "use strict";

  function create(form, { mode, onKeep, summaries = {}, states = {}, externalSteps = [], externalStepsAfter, stepOrder = [] } = {}) {
    const formSteps = [...form.querySelectorAll("[data-guide-step]")];
    const reviewStep = formSteps.find(step => step.dataset.guideStep === "review");
    let steps = [];
    if (stepOrder.length) {
      const byId = new Map([...formSteps, ...externalSteps].map(step => [step.dataset.guideStep, step]));
      steps = stepOrder.map(id => byId.get(id)).filter(step => step && step !== reviewStep);
      steps.push(...[...formSteps, ...externalSteps].filter(step => step !== reviewStep && !steps.includes(step)));
    } else {
      for (const step of formSteps) {
        if (step === reviewStep) continue;
        steps.push(step);
        if (step.dataset.guideStep === externalStepsAfter) steps.push(...externalSteps);
      }
      if (!externalStepsAfter || !steps.some(step => externalSteps.includes(step))) steps.push(...externalSteps);
    }
    if (reviewStep) steps.push(reviewStep);
    const review = form.querySelector("[data-guide-review]");
    const header = document.createElement("div");
    header.className = "guide-header";
    header.innerHTML = `<p class="fine">Take one step at a time. Your answers stay here until you save.</p>
      <p class="guide-state" role="status" aria-live="polite" data-guide-state></p>
      <details class="guide-jump"><summary>Jump to section <span data-guide-progress></span></summary>
        <nav class="guide-nav" aria-label="Wedding setup sections"></nav>
      </details>
      <div class="guide-errors" role="alert" hidden></div>
      <p class="guide-sr" aria-live="polite" aria-atomic="true" data-guide-announcement></p>`;
    form.prepend(header);
    const state = header.querySelector("[data-guide-state]");
    const announcement = header.querySelector("[data-guide-announcement]");
    const errors = header.querySelector(".guide-errors");
    const nav = header.querySelector("nav");
    const jump = header.querySelector(".guide-jump");
    const progress = header.querySelector("[data-guide-progress]");
    const actions = document.createElement("div");
    actions.className = "guide-actions";
    actions.innerHTML = `<div class="guide-meter">
        <div class="guide-meter-track" role="progressbar" aria-label="Setup progress" aria-valuemin="0"><span class="guide-meter-fill"></span></div>
        <p class="guide-meter-text" data-guide-meter></p>
      </div>
      <div class="guide-buttons">
        <button type="button" class="ghost" data-guide-back><span aria-hidden="true">&larr;</span> Back</button>
        <button type="button" class="link" data-guide-skip>Skip for now</button>
        <button type="button" class="ghost" data-guide-save>Save changes</button>
        <button type="button" data-guide-next>Next <span aria-hidden="true">&rarr;</span></button>
        ${mode === "create" ? '<button type="button" class="ghost" data-guide-keep>Keep answers in this tab</button>' : ""}
      </div>`;
    form.append(actions);
    const meter = actions.querySelector(".guide-meter-track");
    const meterFill = actions.querySelector(".guide-meter-fill");
    const meterText = actions.querySelector("[data-guide-meter]");
    let current = 0, saving = false, snapshot = "", saved = "";
    let pendingCreate = false;
    let savingControls = [];
    let nextAnswerId = 0;
    const skipped = new Set();
    const pageTitle = document.title;
    const externalSaved = new Map(externalSteps.map(step => [step.dataset.guideStep, externalFingerprint(step)]));
    function externalFingerprint(step) {
      return JSON.stringify([...step.querySelectorAll("input, select, textarea")].map(input =>
        [input.id, input.name, input.value, input.checked]));
    }
    const externalDirty = step => externalSaved.has(step.dataset.guideStep) &&
      externalSaved.get(step.dataset.guideStep) !== externalFingerprint(step);
    const hasExternalChanges = () => externalSteps.some(externalDirty);
    const ignored = input => !!input.closest("[data-guide-ignore]");
    const fields = root => [...root.querySelectorAll("input, select, textarea")].filter(input => !ignored(input));
    const fingerprint = () => JSON.stringify([
      fields(form).map(input =>
        [input.id, input.name, input.value, input.checked]),
      [...form.querySelectorAll("[data-palette]")].map(el => [el.dataset.palette, el.dataset.names])
    ]);
    saved = fingerprint();
    const dirty = () => fingerprint() !== saved;
    const setState = text => { state.textContent = text; };
    const updateState = () => {
      if (pendingCreate) return;
      if (mode === "create") {
        setState("Draft answers stay in this tab until you create it.");
      } else {
        const weddingChanges = dirty(), privateChanges = hasExternalChanges();
        setState(saving ? "Saving changes..." : weddingChanges && privateChanges
          ? "Wedding and private identity changes are unsaved. Save each in its section before leaving or reloading."
          : privateChanges
            ? "Private identity details are unsaved. Save them in that section before leaving or reloading."
            : weddingChanges
              ? "Unsaved changes. Next and Skip keep answers on this page; use Save changes before leaving or reloading."
              : "Saved wedding details. You can return to any section.");
      }
    };
    function label(input) {
      return input.labels?.[0]?.textContent.trim() || input.getAttribute("aria-label") ||
        input.placeholder || input.id || "This answer";
    }
    const invalidInputs = () => fields(form).filter(input => input.willValidate && !input.validity.valid);
    const ICONS = { complete: "\u2713", progress: "\u25D0", notstarted: "\u25CB", optional: "\u2013", review: "\u2605" };
    function answered(step) {
      return fields(step).some(input => input.type !== "hidden" && input.type !== "checkbox" && input.type !== "radio" &&
        input.tagName !== "SELECT" && input.value.trim()) ||
        [...step.querySelectorAll("[data-palette]")].some(el => (el.dataset.palette || "[]") !== "[]");
    }
    function stepState(step) {
      const id = step.dataset.guideStep;
      if (id === "review") return { kind: "review", text: "Review before publishing" };
      if (externalDirty(step)) return { kind: "progress", text: "Unsaved details" };
      const inputs = fields(step);
      if (inputs.some(input => input.willValidate && !input.validity.valid)) return { kind: "progress", text: "Needs answers" };
      const missing = inputs.some(input => input.dataset.publishRequired && !input.value.trim());
      const optional = step.hasAttribute("data-guide-optional");
      let kind = states[id]?.() || (answered(step) ? (missing ? "progress" : "complete") : "notstarted");
      if (missing && kind === "complete") kind = "progress";
      const text = kind === "complete" ? "Complete"
        : kind === "progress" ? (optional ? "In progress" : "Needs answers")
          : kind === "optional" ? "Optional"
            : optional ? "Not started" : "Not started \u00B7 needs answers";
      return { kind, text: skipped.has(id) && kind !== "complete" ? `${text} \u00B7 skipped for now` : text };
    }
    const sectionStatus = step => stepState(step).text;
    function renderReview() {
      review.replaceChildren();
      const list = document.createElement("ol");
      list.className = "guide-review-list";
      steps.filter(step => step.dataset.guideStep !== "review").forEach(step => {
        const item = document.createElement("li");
        const { kind, text: statusText } = stepState(step);
        item.className = `guide-review-item is-${kind}`;
        item.dataset.state = kind;
        const badge = document.createElement("span");
        badge.className = "guide-badge";
        badge.textContent = `${ICONS[kind]} ${statusText}`;
        const link = document.createElement("a");
        link.href = `#step=${step.dataset.guideStep}`;
        link.textContent = step.dataset.guideTitle;
        link.setAttribute("aria-label", `${step.dataset.guideTitle}: ${statusText}`);
        const text = document.createElement("p");
        text.textContent = summaries[step.dataset.guideStep]?.() || "Optional details can be completed later.";
        item.append(badge, link, text);
        list.append(item);
      });
      review.append(list);
    }
    steps.forEach((step, index) => {
      const heading = document.createElement("h2");
      heading.className = "guide-heading";
      heading.id = `guide-heading-${step.dataset.guideStep}`;
      heading.tabIndex = -1;
      heading.textContent = step.dataset.guideTitle;
      step.setAttribute("aria-labelledby", heading.id);
      step.prepend(heading);
      const button = document.createElement("button");
      button.type = "button";
      const caption = document.createElement("span");
      caption.textContent = `${index + 1}. ${step.dataset.guideTitle}`;
      button.append(caption, document.createElement("small"));
      button.addEventListener("click", () => go(index));
      nav.append(button);
    });
    const navButtons = [...nav.children];
    const mobileNavigation = global.matchMedia("(max-width: 600px)");
    const syncNavigationMode = () => { jump.open = !mobileNavigation.matches; };
    syncNavigationMode();
    mobileNavigation.addEventListener("change", syncNavigationMode);
    function refresh() {
      let complete = 0;
      const countable = steps.filter(step => step.dataset.guideStep !== "review").length;
      navButtons.forEach((button, index) => {
        const { kind, text } = stepState(steps[index]);
        if (kind === "complete") complete++;
        button.dataset.state = kind;
        button.querySelector("small").textContent = `${ICONS[kind]} ${text}`;
      });
      const percent = countable ? Math.round(complete / countable * 100) : 0;
      meter.setAttribute("aria-valuemax", String(countable));
      meter.setAttribute("aria-valuenow", String(complete));
      meter.setAttribute("aria-valuetext", `${complete} of ${countable} sections complete`);
      meter.dataset.level = percent >= 100 ? "done" : percent >= 50 ? "mid" : "low";
      meterFill.style.width = `${percent}%`;
      meterText.textContent = `Step ${current + 1} of ${steps.length} \u00B7 ${complete} of ${countable} sections complete`;
      actions.dataset.level = meter.dataset.level;
      renderReview();
      updateState();
    }
    function show(index, focus = true) {
      current = index;
      steps.forEach((step, i) => { step.hidden = i !== index; });
      navButtons.forEach((button, i) => {
        if (i === index) {
          button.setAttribute("aria-current", "step");
          if (nav.scrollWidth > nav.clientWidth) nav.scrollLeft = button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2;
        } else button.removeAttribute("aria-current");
      });
      actions.querySelector("[data-guide-back]").disabled = index === 0;
      actions.querySelector("[data-guide-next]").disabled = index === steps.length - 1;
      actions.querySelector("[data-guide-skip]").disabled = index === steps.length - 1;
      announcement.textContent = `Step ${index + 1} of ${steps.length}: ${steps[index].dataset.guideTitle}`;
      progress.textContent = ` · Step ${index + 1} of ${steps.length}`;
      document.title = `Step ${index + 1} of ${steps.length}: ${steps[index].dataset.guideTitle} — ${pageTitle}`;
      refresh();
      if (focus) steps[index].querySelector("h2").focus({ preventScroll: false });
    }
    function go(index) {
      if (mobileNavigation.matches) jump.open = false;
      const hash = `#step=${steps[index].dataset.guideStep}`;
      if (location.hash !== hash) history.pushState(null, "", hash);
      show(index);
    }
    function reveal(target) {
      const step = target?.closest("[data-guide-step]");
      if (step && steps.includes(step)) {
        go(steps.indexOf(step));
      }
      let parent = target?.parentElement;
      while (parent) {
        if (parent.tagName === "DETAILS") parent.open = true;
        parent = parent.parentElement;
      }
    }
    function fromHash(focus = true) {
      if (location.hash.startsWith("#step=")) {
        const index = steps.findIndex(step => `#step=${step.dataset.guideStep}` === location.hash);
        if (index !== -1) {
          show(index, focus);
        }
      } else if (location.hash) {
        let id;
        try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
        const target = document.getElementById(id);
        if (target) {
          const step = target.closest("[data-guide-step]");
          if (step && steps.includes(step)) show(steps.indexOf(step), false);
          if (target.tagName === "DETAILS") target.open = true;
          let parent = target.parentElement;
          while (parent) {
            if (parent.tagName === "DETAILS") parent.open = true;
            parent = parent.parentElement;
          }
          if (focus) {
            if (!target.matches("input, select, textarea, button, a")) target.tabIndex = -1;
            target.focus();
            target.scrollIntoView({ block: "center", behavior: "auto" });
          }
        }
      }
    }
    function validate(reason = "save") {
      const invalid = invalidInputs();
      if (reason === "publish") {
        form.querySelectorAll("[data-publish-required]").forEach(input => {
          if (!input.value.trim() && !invalid.includes(input)) invalid.push(input);
        });
      }
      errors.hidden = !invalid.length;
      errors.replaceChildren();
      if (!invalid.length) return true;
      const title = document.createElement("strong");
      title.textContent = reason === "publish" ? "Before publishing, complete these answers:" :
        mode === "create" ? "Before creating your draft, check these answers (only names and valid accounting settings are required):" :
          "Complete these answers before saving to the server:";
      errors.append(title);
      invalid.forEach(input => {
        input.setAttribute("aria-invalid", "true");
        const link = document.createElement("a");
        link.href = `#step=${input.closest("[data-guide-step]")?.dataset.guideStep || "review"}`;
        link.textContent = `${label(input)}: ${input.validationMessage || "Required before publishing"}`;
        link.addEventListener("click", event => {
          event.preventDefault();
          reveal(input);
          input.focus();
          input.reportValidity();
        });
        errors.append(link);
      });
      reveal(invalid[0]);
      invalid[0].focus();
      refresh();
      return false;
    }
    function blockPublication(missing) {
      errors.hidden = false;
      errors.replaceChildren();
      const caption = document.createElement("strong");
      caption.textContent = "Before publishing, complete these saved answers:";
      errors.append(caption);
      const labels = {
        "couple-names": ["Couple names and site address", "couple"],
        "wedding-slug": ["Couple names and site address", "couple"],
        "wedding-date": ["Wedding date", "date"],
        location: ["Wedding location", "date"],
        "venues-section": ["A complete wedding-day event: name, date, start time and street address", "venues"],
        "welcome-story": ["A short welcome story", "couple"],
        "fundraising-route": ["A fundraising option and ready guest-payment currency", "giving"]
      };
      missing.forEach(id => {
        const link = document.createElement("a");
        const [text, step] = labels[id] || [id, "review"];
        link.href = `#step=${step}`;
        link.textContent = text;
        errors.append(link);
      });
    }
    function draftRequirements() {
      form.querySelectorAll("[data-guide-step=venues] input:not([type=hidden]):not([type=radio]):not([type=checkbox]), [data-guide-step=venues] select, [data-guide-step=venues] textarea").forEach(input => {
        if (!input.id) input.id = `guide-event-answer-${nextAnswerId++}`;
        if (!input.labels?.length) {
          const caption = document.createElement("label");
          caption.htmlFor = input.id;
          caption.textContent = input.getAttribute("aria-label") || input.placeholder || (input.tagName === "SELECT" ? "Event type" : "Event answer");
          input.before(caption);
        }
      });
      form.querySelectorAll("#wedding-date, #location, [data-guide-step=venues] input[required], [data-publish-required]").forEach(input => {
        if (input.required || input.dataset.publishRequired) {
          input.dataset.publishRequired = "true";
          input.required = false;
          input.removeAttribute("aria-required");
          input.labels?.forEach(caption => {
            caption.querySelectorAll('[title="Required"], .required-mark').forEach(mark => { mark.textContent = ""; });
            if (!caption.querySelector("[data-publish-note]")) {
              const note = document.createElement("span");
              note.className = "fine";
              note.dataset.publishNote = "true";
              note.textContent = " (needed to publish; can wait on a draft)";
              caption.append(note);
            }
          });
        }
      });
    }
    draftRequirements();
    saved = fingerprint();
    new MutationObserver(() => { draftRequirements(); }).observe(form, { childList: true, subtree: true });
    actions.querySelector("[data-guide-back]").addEventListener("click", () => go(Math.max(0, current - 1)));
    actions.querySelector("[data-guide-next]").addEventListener("click", () => go(Math.min(steps.length - 1, current + 1)));
    actions.querySelector("[data-guide-skip]").addEventListener("click", () => {
      skipped.add(steps[current].dataset.guideStep);
      go(Math.min(steps.length - 1, current + 1));
    });
    actions.querySelector("[data-guide-save]").addEventListener("click", () => form.requestSubmit());
    actions.querySelector("[data-guide-keep]")?.addEventListener("click", () => onKeep?.());
    form.addEventListener("input", event => {
      event.target.removeAttribute("aria-invalid");
      skipped.delete(event.target.closest("[data-guide-step]")?.dataset.guideStep);
      refresh();
    });
    form.addEventListener("change", refresh);
    form.addEventListener("click", () => queueMicrotask(refresh));
    externalSteps.forEach(step => {
      step.addEventListener("input", event => {
        event.target.removeAttribute("aria-invalid");
        skipped.delete(step.dataset.guideStep);
        refresh();
      });
      step.addEventListener("change", refresh);
    });
    global.addEventListener("hashchange", () => fromHash());
    const syncViewport = () => {
      const viewport = global.visualViewport;
      const obscured = viewport ? Math.max(0, global.innerHeight - viewport.offsetTop - viewport.height) : 0;
      actions.style.setProperty("--guide-viewport-bottom", `${obscured}px`);
    };
    global.visualViewport?.addEventListener("resize", syncViewport);
    global.visualViewport?.addEventListener("scroll", syncViewport);
    syncViewport();
    global.addEventListener("beforeunload", event => {
      if (mode === "edit" && (dirty() || hasExternalChanges())) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    show(0, false);
    fromHash();
    return {
      reveal, validate, dirty, refresh, setState, blockPublication,
      markExternalSaved(name) {
        const step = externalSteps.find(item => item.dataset.guideStep === name);
        if (step) externalSaved.set(name, externalFingerprint(step));
        refresh();
      },
      reviewBeforePublish() {
        if (current === steps.length - 1) return true;
        go(steps.length - 1);
        return false;
      },
      saving() {
        snapshot = fingerprint();
        saving = true;
        savingControls = [...form.querySelectorAll("input, select, textarea, button")].filter(control => !control.disabled);
        savingControls.forEach(control => { control.disabled = true; });
        form.setAttribute("aria-busy", "true");
        updateState();
      },
      unchangedSinceSave() { return fingerprint() === snapshot; },
      saved(unchanged) { saved = unchanged ? fingerprint() : snapshot; saving = false; refresh(); },
      failed() {
        saving = false;
        savingControls.forEach(control => { control.disabled = false; });
        savingControls = [];
        form.removeAttribute("aria-busy");
        updateState();
      },
      created() {
        pendingCreate = true;
        actions.querySelectorAll("button").forEach(button => { button.disabled = true; });
        setState("Wedding created and saved to your account. Opening your wedding guide; do not create it again.");
      }
    };
  }

  global.WSGuidedSetup = { create };
})(window);
