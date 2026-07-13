(function initializeDeepLTranslateProvider(globalScope) {
  "use strict";

  // DeepL takes the request as a hash deep link: #<source>/<target>/<text>. As with
  // Google, that lets the page translate on load instead of us typing into it.
  //
  // The locale-prefixed path is deliberate: the bare /translator redirects, and
  // automating a page that is still redirecting is how the old version failed.
  const BASE_URL = "https://www.deepl.com/en/translator";
  // DeepL's free web translator caps input well below Google's.
  const MAX_CHUNK_CHARS = 1400;
  const MAX_URL_TEXT_CHARS = 1800;

  function buildUrl({ sourceLang, targetLang, text }) {
    const source = sourceLang || "auto";
    const target = targetLang || "en";
    const encodedText = encodeURIComponent(text || "");
    const includesText = Boolean(text) && encodedText.length <= MAX_URL_TEXT_CHARS;
    const hash = includesText
      ? `#${source}/${target}/${encodedText}`
      : `#${source}/${target}/`;

    return { url: `${BASE_URL}${hash}`, includesText };
  }

  const provider = globalScope.WonderTranslationAutomation.createBrowserTranslationProvider(
    {
      id: "deepl",
      label: "DeepL",
      hostPermission: "https://www.deepl.com/*",
      expectedHost: "deepl.com",
      maxChunkChars: MAX_CHUNK_CHARS,
      buildUrl,
      selectors: {
        // DeepL puts `data-testid` on a <d-textarea> custom element that is NOT
        // itself editable (it has no contenteditable attribute at all); the caret
        // lives in a contenteditable <div> inside it. Selecting the wrapper finds
        // an element we cannot type into, so both selectors reach through to the
        // inner node.
        input: '[data-testid="translator-source-input"] div[contenteditable="true"]',
        inputFallback:
          '[data-testid="translator-source-input"] [role="textbox"], d-textarea [contenteditable="true"]',
        output: {
          walk: [],
          // Tried in order, every match joined: DeepL renders one <p> per
          // sentence. The aria hook is first because it names the region by role
          // rather than by DeepL's internal test ids; the data-testid selectors
          // stay as fallbacks, and the last one catches a short phrase that lands
          // as a bare text node with no <p> wrapper.
          selectors: [
            '[aria-labelledby="translation-target-heading"] > div > p',
            '[data-testid="translator-target-input"] div[contenteditable="true"] p',
            '[data-testid="translator-target-input"] div[contenteditable="true"]',
          ],
        },
      },
    },
  );

  globalScope.DeepLTranslateProvider = provider;
})(self);
