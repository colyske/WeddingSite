(function (root) {
  root.WSAmountPresetEditor = function () {
    const $ = id => document.getElementById(id);
    const presets = root.WSAmountPresets;
    let savedCurrency, savedPresets, maxMinor, dirty = false;
    const write = value => {
      for (const kind of ["song", "gift"]) $(`preset-${kind}`).value = value[kind].map(n => n / 100).join(", ");
    };
    const preview = () => {
      try {
        const currency = $("currency").value;
        const value = presets.normalize({ currency, song: presets.parse($("preset-song").value), gift: presets.parse($("preset-gift").value) }, currency, maxMinor);
        $("preset-preview").textContent = ["song", "gift"].map(kind => `${kind === "song" ? "Song bids" : "Voluntary gifts"}: ${value[kind].map(n => presets.label(n, currency)).join("; ")}`).join(" | ");
        $("preset-preview").dataset.valid = "true";
      } catch (error) {
        $("preset-preview").textContent = error.message;
        $("preset-preview").dataset.valid = "false";
      }
    };
    for (const kind of ["song", "gift"]) $(`preset-${kind}`).addEventListener("input", () => {
      dirty = true;
      $("preset-reviewed").checked = false;
      preview();
    });
    $("currency").addEventListener("change", () => {
      dirty = true;
      $("preset-reviewed").checked = false;
      write({ song: [], gift: [] });
      $("preset-currency").textContent = $("currency").value;
      $("preset-state").textContent = "Currency changed. Previous amounts were cleared, not converted. Enter or suggest new amounts, then explicitly review them.";
      preview();
    });
    $("preset-suggest").addEventListener("click", () => {
      $("preset-reset").checked = false;
      const currency = $("currency").value;
      const suggestion = currency === "KES"
        ? { song: [10000, 50000, 100000], gift: [50000, 100000, 500000] }
        : currency === "USD" ? presets.defaults : null;
      if (!suggestion) {
        $("preset-state").textContent = "No deterministic suggestions are defined for this currency. Enter your own amounts.";
        return;
      }
      write(suggestion);
      dirty = true;
      $("preset-reviewed").checked = false;
      $("preset-state").textContent = "Deterministic currency-aware suggestions only, not AI or exchange-rate conversion. Review and edit before saving.";
      preview();
    });
    $("preset-reset").addEventListener("change", () => {
      dirty = true;
      $("preset-reviewed").checked = false;
      $("preset-state").textContent = $("preset-reset").checked
        ? "Saving will clear the stored lists and restore legacy guest defaults. Review and confirm."
        : "Saved organizer choices. They are kept until you explicitly edit them.";
      preview();
    });
    document.addEventListener("weddingsitefxchange", preview);
    return {
      load(wedding, cap) {
        savedCurrency = wedding.currency;
        savedPresets = wedding.amount_presets || null;
        maxMinor = cap;
        dirty = false;
        write(wedding.amount_presets || presets.defaults);
        $("preset-currency").textContent = savedCurrency;
        $("preset-reviewed").checked = false;
        $("preset-reset").checked = false;
        $("preset-state").textContent = wedding.amount_presets
          ? "Saved organizer choices. They are kept until you explicitly edit them."
          : "Legacy defaults shown. They remain unset unless you edit or explicitly apply suggestions.";
        $("preset-limit").textContent = Number.isSafeInteger(cap)
          ? `Checkout limit per amount: ${presets.label(cap, savedCurrency)}.`
          : "Checkout limit unavailable. Suggested amounts cannot be changed.";
        preview();
      },
      payload() {
        if (!dirty) return {};
        if (!$("preset-reviewed").checked) throw new Error("Review and confirm the suggested amounts in the selected currency before saving.");
        if ($("preset-reset").checked) return {
          amountPresets: null, amountPresetsReviewed: true,
          amountPresetsBaseCurrency: savedCurrency, amountPresetsBase: savedPresets
        };
        const currency = $("currency").value;
        const amountPresets = presets.normalize({ currency, song: presets.parse($("preset-song").value), gift: presets.parse($("preset-gift").value) }, currency, maxMinor);
        return { amountPresets, amountPresetsReviewed: true, amountPresetsBaseCurrency: savedCurrency, amountPresetsBase: savedPresets };
      },
      saved(wedding) {
        savedCurrency = wedding.currency;
        savedPresets = wedding.amount_presets || null;
        dirty = false;
        $("preset-reviewed").checked = false;
        $("preset-reset").checked = false;
        $("preset-state").textContent = "Saved organizer choices. They are kept until you explicitly edit them.";
      }
    };
  };
})(globalThis);
