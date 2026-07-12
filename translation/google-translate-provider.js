(function initializeGoogleTranslateProvider(globalScope) {
  "use strict";

  const provider = globalScope.WonderTranslationAutomation.createBrowserTranslationProvider(
    {
      id: "google-translate",
      label: "Google Translate",
      url: "https://translate.google.com/",
      hostPermission: "https://translate.google.com/*",
      selectors: {
        // Primary input per the current Google Translate UI.
        input: '[aria-label="Source text"]',
        // Resilient fallback if the aria-label ever changes.
        inputFallbackCandidates:
          "textarea, input[type='text'], [contenteditable='true'], [role='textbox']",
        output: {
          mode: "google-copy-span",
          container: '[jsaction^="copy:"]',
          // Anchor-based fallback used by the previous implementation.
          anchorSelector: "span",
          anchorText: "Send feedback",
        },
      },
    },
  );

  globalScope.GoogleTranslateProvider = provider;
})(self);
