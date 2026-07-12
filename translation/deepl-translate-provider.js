(function initializeDeepLTranslateProvider(globalScope) {
  "use strict";

  // DeepL puts `data-testid` on a <d-textarea> custom element that is *not*
  // itself editable; the caret lives in a contenteditable <div role="textbox">
  // inside it. Selecting the wrapper finds an element we cannot type into, so
  // both selectors below reach through to the inner editable node.
  const provider = globalScope.WonderTranslationAutomation.createBrowserTranslationProvider(
    {
      id: "deepl",
      label: "DeepL",
      // The bare /translator path redirects to a locale-prefixed URL; going
      // straight there avoids automating a page that is still redirecting.
      url: "https://www.deepl.com/en/translator",
      hostPermission: "https://www.deepl.com/*",
      selectors: {
        input: '[data-testid="translator-source-input"] div[contenteditable="true"]',
        inputFallbackCandidates:
          '[data-testid="translator-source-input"] [role="textbox"], d-textarea [contenteditable="true"]',
        output: {
          mode: "text",
          // DeepL renders one <p> per sentence inside the target editor.
          selector:
            '[data-testid="translator-target-input"] div[contenteditable="true"] p',
          // Short phrases can land as a bare text node with no <p> wrapper.
          fallbackSelector:
            '[data-testid="translator-target-input"] div[contenteditable="true"]',
        },
      },
    },
  );

  globalScope.DeepLTranslateProvider = provider;
})(self);
