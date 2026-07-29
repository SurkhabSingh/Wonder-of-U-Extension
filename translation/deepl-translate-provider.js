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
          // Tried in order, every match joined with a newline. DeepL renders one <p>
          // per INPUT LINE, so reading them all yields a translation with the same
          // number of lines as the transcript — the 1:1 pairing the app needs, with
          // no API key involved.
          //
          // A descendant selector, not `> div > p`: the paragraphs are not direct
          // children of that region, so the strict chain matched only whatever sat at
          // that exact depth and dropped the rest of the translation.
          selectors: [
            'd-textarea [aria-labelledby="translation-target-heading"] p',
            '[data-testid="translator-target-input"] div[contenteditable="true"] p',
            // Last resort: a short phrase can land as a bare text node with no <p>
            // wrapper at all, which the two above would miss entirely.
            '[data-testid="translator-target-input"] div[contenteditable="true"]',
          ],
        },
      },
    },
  );

  globalScope.DeepLTranslateProvider = provider;
})(self);
