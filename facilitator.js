(() => {
  const button = document.getElementById("copy-consent");
  const quote = document.getElementById("consent-copy");
  const status = document.getElementById("copy-status");
  if (!button || !quote || !status) return;

  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(quote.textContent.trim());
      status.textContent = "Consent request copied. Review and personalize it before sending.";
    } catch {
      status.textContent = "Clipboard unavailable. Select the message above and copy it manually.";
    }
  });
})();
