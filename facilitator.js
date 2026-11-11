(() => {
  for (const button of document.querySelectorAll("[data-copy-target]")) {
    const message = document.getElementById(button.dataset.copyTarget);
    const status = document.getElementById(button.dataset.copyStatus);
    if (!message || !status) continue;

    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(message.textContent.trim());
        status.textContent = button.dataset.copySuccess || "Message copied.";
      } catch {
        status.textContent = "Clipboard unavailable. Select and copy the message above.";
      }
    });
  }
})();
