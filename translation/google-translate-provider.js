(function initializeGoogleTranslateProvider(globalScope) {
  "use strict";

  // Google Translate accepts the whole request in the query string, so we can
  // hand it the text and both languages up front and let it translate on load.
  // That removes the two least reliable steps of the old automation: waiting for
  // the input box to appear, and typing into it in a tab Chrome is throttling.
  const BASE_URL = "https://translate.google.com/";
  // The web UI stops translating well before this, and Google's own API guidance
  // is to keep a request under 5k characters.
  const MAX_CHUNK_CHARS = 4500;
  // Anything longer is typed instead. Encoded CJK runs ~9 bytes per character, so
  // this is measured after encoding rather than before it.
  const MAX_URL_TEXT_CHARS = 1800;

  function buildUrl({ sourceLang, targetLang, text }) {
    const params = new URLSearchParams({
      sl: sourceLang || "auto",
      tl: targetLang || "en",
      op: "translate",
    });

    const encodedText = encodeURIComponent(text || "");
    const includesText = Boolean(text) && encodedText.length <= MAX_URL_TEXT_CHARS;

    if (includesText) {
      params.set("text", text);
    }

    return { url: `${BASE_URL}?${params.toString()}`, includesText };
  }

  const provider = globalScope.WonderTranslationAutomation.createBrowserTranslationProvider(
    {
      id: "google-translate",
      label: "Google Translate",
      hostPermission: "https://translate.google.com/*",
      expectedHost: "translate.google.com",
      maxChunkChars: MAX_CHUNK_CHARS,
      buildUrl,
      selectors: {
        input: '[aria-label="Source text"]',
        inputFallback: "textarea, [contenteditable='true'], [role='textbox']",
        output: {
          // Descend from the copy container to the translated span, taking the
          // first match at each step. Verified against the rendered page: this
          // lands on span[jsname="W297wb"], which holds the translation and
          // nothing else.
          //
          // It has to be a walk. The flattened CSS equivalent
          // ('[jsaction^="copy:"] div div[dir="ltr"] span span span') matches
          // seven nodes, including "Try again" and several "." — only taking the
          // first descendant at each step isolates the translation.
          walk: [
            '[jsaction^="copy:"]',
            'div div[dir="ltr"]',
            "span",
            "span",
            "span",
          ],
          // If Google reshuffles that structure, its own hook still finds the
          // span. Kept second because the walk depends on nothing Google-internal.
          selectors: ['span[jsname="W297wb"]'],
        },
      },
    },
  );

  globalScope.GoogleTranslateProvider = provider;
})(self);
