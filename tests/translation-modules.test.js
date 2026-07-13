"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

// Mutable test doubles: individual assertions below re-point these to drive the
// module under test down a specific branch.
const state = {
  grantedOrigins: new Set(),
  translationSettings: {},
  fetchResponse: null,
  fetchCalls: [],
  registeredScripts: [],
  updatedScripts: [],
  unregisteredIds: [],
  registerShouldThrow: false,
};

const context = vm.createContext({
  console,
  clearTimeout,
  setTimeout,
  // utils.js parses endpoints with `new URL(...)`; without these here every parse
  // throws and sanitizeBridgeEndpoint silently returns its default, which would
  // make the endpoint assertions below pass for the wrong reason.
  URL,
  URLSearchParams,
  AbortController,
  fetch: async (url, options) => {
    state.fetchCalls.push({ url, options });
    return state.fetchResponse;
  },
  chrome: {
    permissions: {
      contains: async ({ origins }) =>
        origins.every((origin) => state.grantedOrigins.has(origin)),
    },
    storage: {
      local: {
        get: async () => ({ translationSettings: state.translationSettings }),
      },
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) =>
        state.registeredScripts.filter((script) => ids.includes(script.id)),
      registerContentScripts: async (scripts) => {
        if (state.registerShouldThrow) {
          state.registerShouldThrow = false;
          throw new Error("Duplicate script ID");
        }
        state.registeredScripts.push(...scripts);
      },
      updateContentScripts: async (scripts) => {
        state.updatedScripts.push(...scripts);
      },
      unregisterContentScripts: async ({ ids }) => {
        state.unregisteredIds.push(...ids);
        state.registeredScripts = state.registeredScripts.filter(
          (script) => !ids.includes(script.id),
        );
      },
    },
  },
});

context.self = context;

for (const relativePath of [
  "utils.js",
  "translation/provider-shim.js",
  "translation/provider-automation.js",
  "translation/google-translate-provider.js",
  "translation/deepl-translate-provider.js",
  "translation/deepl-api-provider.js",
  "translation/translation-service.js",
]) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  vm.runInContext(source, context, { filename: relativePath });
}

// utils.js exposes its constants as top-level `const`s, which are lexical bindings
// in the context rather than properties on it, so they have to be read by
// evaluating inside the context.
const evaluate = (expression) => vm.runInContext(expression, context);

async function run() {
  // --- Registration -------------------------------------------------------
  assert.equal(context.TranslationService.hasProvider("google-translate"), true);
  assert.equal(context.TranslationService.hasProvider("deepl"), true);

  // --- Google: the request goes in the URL, not the input box -------------
  const googleUrl = context.GoogleTranslateProvider.config.buildUrl({
    sourceLang: "ja",
    targetLang: "es",
    text: "こんにちは",
  });

  assert.equal(googleUrl.includesText, true);
  const googleParams = new URL(googleUrl.url).searchParams;
  assert.equal(googleParams.get("sl"), "ja");
  assert.equal(googleParams.get("tl"), "es");
  assert.equal(googleParams.get("op"), "translate");
  assert.equal(googleParams.get("text"), "こんにちは");

  // Text too long to survive a URL must fall back to typing, not be truncated.
  const longGoogleUrl = context.GoogleTranslateProvider.config.buildUrl({
    sourceLang: "auto",
    targetLang: "en",
    text: "あ".repeat(1000),
  });
  assert.equal(longGoogleUrl.includesText, false);
  assert.equal(new URL(longGoogleUrl.url).searchParams.has("text"), false);
  assert.equal(new URL(longGoogleUrl.url).searchParams.get("tl"), "en");

  // --- Google: output extraction ------------------------------------------
  // Verified against the real rendered page (headless Chrome, not a static fetch —
  // Google renders the translation client-side). The walk lands on the translated
  // span alone. It must stay a walk: the flattened CSS equivalent of the same
  // chain also matches "Try again" and several "." nodes, so only taking the first
  // descendant at each step isolates the translation.
  const googleOutput =
    context.GoogleTranslateProvider.config.pageConfig.selectors.output;
  assert.deepEqual(
    [...googleOutput.walk],
    ['[jsaction^="copy:"]', 'div div[dir="ltr"]', "span", "span", "span"],
  );
  assert.ok(
    [...googleOutput.selectors].includes('span[jsname="W297wb"]'),
    "Google's own hook stays as the fallback if the structure shifts",
  );
  assert.ok(
    [...googleOutput.walk, ...googleOutput.selectors].every(
      (selector) => !selector.includes("Send feedback"),
    ),
    "the locale-locked 'Send feedback' anchor must be gone",
  );

  // --- DeepL: output + input ------------------------------------------------
  const deeplSelectors =
    context.DeepLTranslateProvider.config.pageConfig.selectors;
  assert.equal(
    [...deeplSelectors.output.selectors][0],
    '[aria-labelledby="translation-target-heading"] > div > p',
    "the aria hook is the primary: it names the region by role, not by a test id",
  );
  // The element carrying data-testid is a <d-textarea> with no contenteditable
  // attribute — it cannot be typed into. The input selector must reach the inner
  // editable node or the typing fallback silently does nothing.
  assert.match(deeplSelectors.input, /div\[contenteditable="true"\]$/);

  // --- DeepL: hash deep link ----------------------------------------------
  const deeplUrl = context.DeepLTranslateProvider.config.buildUrl({
    sourceLang: "ja",
    targetLang: "en",
    text: "こんにちは",
  });
  assert.equal(deeplUrl.includesText, true);
  assert.ok(
    deeplUrl.url.startsWith("https://www.deepl.com/en/translator#ja/en/"),
    `unexpected DeepL deep link: ${deeplUrl.url}`,
  );
  assert.ok(deeplUrl.url.endsWith(encodeURIComponent("こんにちは")));

  // --- Chunking: long transcripts must not be silently truncated ----------
  // Spread the results into host arrays: values built inside the vm carry the
  // vm's Array prototype, which deepEqual treats as a different type.
  const split = (text, limit) => [
    ...context.WonderTranslationAutomation.splitIntoChunks(text, limit),
  ];
  assert.deepEqual(split("short text", 4000), ["short text"]);

  // `splitIntoChunks` floors the cap at 200 characters, so exercise it there.
  const limit = 200;
  const sentences = Array.from(
    { length: 12 },
    (_, index) => `Sentence number ${index} carries a little text.`,
  ).join(" ");
  assert.ok(sentences.length > limit);

  const chunks = split(sentences, limit);
  assert.ok(chunks.length > 1, "a long transcript must be split");
  assert.ok(
    chunks.every((chunk) => chunk.length <= limit),
    `every chunk must respect the cap: ${JSON.stringify(chunks)}`,
  );
  assert.equal(
    chunks.join(" ").replace(/\s+/g, " "),
    sentences,
    "chunking must preserve the whole transcript",
  );

  // A single unbroken run longer than the cap still has to be emitted whole.
  const wrapped = split("x".repeat(500), limit);
  assert.equal(wrapped.join(""), "x".repeat(500));
  assert.ok(wrapped.every((chunk) => chunk.length <= limit));

  // --- DeepL API provider --------------------------------------------------
  const api = context.DeepLApiProvider;
  assert.equal(
    api.endpointForKey("abc:fx"),
    "https://api-free.deepl.com/v2/translate",
    "a free key must go to api-free or DeepL rejects it",
  );
  assert.equal(api.endpointForKey("abc"), "https://api.deepl.com/v2/translate");
  assert.equal(api.toDeepLTarget("en"), "EN-US");
  assert.equal(api.toDeepLTarget("ja"), "JA");

  // DeepL resolves to page automation without a key, and to the API with one.
  state.translationSettings = { provider: "deepl" };
  assert.equal(
    await context.TranslationService.resolveProvider("deepl"),
    context.DeepLTranslateProvider,
  );

  state.translationSettings = { provider: "deepl", deeplApiKey: "key:fx" };
  assert.equal(
    await context.TranslationService.resolveProvider("deepl"),
    context.DeepLApiProvider,
  );

  // With a key but no host permission, it must say so rather than silently fail.
  state.grantedOrigins = new Set();
  const missingApiPermission = await context.TranslationService.capture(
    "deepl",
    "hello",
    { targetLang: "ja" },
  );
  assert.match(missingApiPermission.errorText, /permission/i);

  // Happy path: the key, target language, and text all reach DeepL.
  state.grantedOrigins = new Set(["https://api-free.deepl.com/*"]);
  state.fetchResponse = {
    ok: true,
    status: 200,
    json: async () => ({ translations: [{ text: "こんにちは" }] }),
  };
  state.fetchCalls = [];

  const apiResult = await context.TranslationService.capture("deepl", "hello", {
    sourceLang: "en",
    targetLang: "ja",
  });
  assert.equal(apiResult.translatedText, "こんにちは");
  assert.equal(state.fetchCalls.length, 1);

  const sentBody = JSON.parse(state.fetchCalls[0].options.body);
  assert.deepEqual(sentBody.text, ["hello"]);
  assert.equal(sentBody.target_lang, "JA");
  assert.equal(sentBody.source_lang, "EN");
  assert.equal(
    state.fetchCalls[0].options.headers.Authorization,
    "DeepL-Auth-Key key:fx",
  );

  // Quota exhaustion is a distinct, actionable message, not a bare status code.
  state.fetchResponse = { ok: false, status: 456 };
  const quotaResult = await context.TranslationService.capture("deepl", "hello");
  assert.match(quotaResult.errorText, /quota/i);

  // --- Page providers: guard rails ----------------------------------------
  state.translationSettings = {};
  state.grantedOrigins = new Set();

  const unknownProviderResult = await context.TranslationService.capture(
    "missing-provider",
    "hello",
  );
  assert.match(unknownProviderResult.errorText, /unavailable/i);

  for (const providerId of ["google-translate", "deepl"]) {
    const emptyInputResult = await context.TranslationService.capture(
      providerId,
      " ",
    );
    assert.equal(emptyInputResult.translatedText, "");
    assert.match(emptyInputResult.errorText, /empty/i);

    const missingPermissionResult = await context.TranslationService.capture(
      providerId,
      "hello",
    );
    assert.equal(missingPermissionResult.translatedText, "");
    assert.match(missingPermissionResult.errorText, /permission/i);
  }

  // --- The shim must signal through the DOM, not through `window` -----------
  // The shim runs in the page's MAIN world; the automation runs in the extension's
  // ISOLATED world. They have separate `window` objects and share only the DOM, so
  // a flag on `window` is invisible to the automation and every failure would
  // misreport as "the shim never arrived".
  const shimSource = fs.readFileSync(
    path.join(projectRoot, "translation/page-visibility-shim.js"),
    "utf8",
  );
  assert.match(
    shimSource,
    /documentElement\.setAttribute\(\s*SHIM_MARKER/,
    "the shim must mark the DOM, which is the only thing both worlds share",
  );
  assert.match(
    shimSource,
    /MutationObserver/,
    "documentElement does not exist at document_start, so the mark has to wait for it",
  );
  assert.equal(
    context.ProviderVisibilityShim.markerAttribute,
    "data-wonder-of-u-shim",
  );
  assert.ok(
    shimSource.includes('"data-wonder-of-u-shim"'),
    "the shim and the automation must agree on the marker attribute",
  );

  // --- The visibility shim -------------------------------------------------
  // This is the regression that matters most. Measured in a real Chrome on a
  // genuinely hidden tab: Google returns nothing after 45s without the shim, and
  // translates in 2s with it, because Google commits its result through
  // requestAnimationFrame, which Chrome suspends when a tab is hidden. If this
  // registration ever silently stops happening, Google silently stops working and
  // DeepL keeps working, which is exactly how it failed in the field.
  const shim = context.ProviderVisibilityShim;

  state.grantedOrigins = new Set();
  state.registeredScripts = [];
  let result = await shim.sync();
  assert.equal(
    result.registered,
    false,
    "nothing to register without a provider permission",
  );

  state.grantedOrigins = new Set(["https://translate.google.com/*"]);
  result = await shim.sync();
  assert.equal(result.registered, true);
  assert.equal(state.registeredScripts.length, 1);

  const script = state.registeredScripts[0];
  assert.equal(
    script.world,
    "MAIN",
    "the shim must patch the page's own requestAnimationFrame, not the isolated world's",
  );
  assert.equal(
    script.runAt,
    "document_start",
    "the shim must replace requestAnimationFrame before the provider's scripts capture it",
  );
  assert.deepEqual([...script.matches], ["https://translate.google.com/*"]);
  assert.deepEqual([...script.js], ["translation/page-visibility-shim.js"]);

  // Re-syncing is idempotent: it updates the existing script rather than trying to
  // register the same id twice (which throws).
  state.updatedScripts = [];
  result = await shim.sync();
  assert.equal(result.registered, true);
  assert.equal(state.updatedScripts.length, 1);
  assert.equal(state.registeredScripts.length, 1);

  // A registration that fails must repair itself rather than stay broken for the
  // life of the profile, leaving Google quietly non-functional.
  state.registeredScripts = [];
  state.unregisteredIds = [];
  state.registerShouldThrow = true;
  result = await shim.sync();
  assert.equal(
    result.registered,
    true,
    "a failed registration must be retried from clean",
  );
  assert.ok(
    state.unregisteredIds.includes(shim.id),
    "the wedged script must be torn down before retrying",
  );

  // --- Settings ------------------------------------------------------------
  // The bridge must not sit on a port Anki already owns: 8765 is AnkiConnect and
  // 8766 is the furigana add-on. Pointing there means we talk to Anki, which
  // answers /v1/* with 404 and reads as "bridge not connected".
  assert.equal(evaluate("DEFAULT_BRIDGE_ENDPOINT"), "http://127.0.0.1:8791");
  assert.equal(
    evaluate('sanitizeBridgeEndpoint("http://127.0.0.1:8766")'),
    evaluate("DEFAULT_BRIDGE_ENDPOINT"),
    "an endpoint saved on Anki's old port must be migrated, not preserved",
  );
  assert.equal(
    evaluate('sanitizeBridgeEndpoint("http://127.0.0.1:9100")'),
    "http://127.0.0.1:9100",
    "a deliberate custom endpoint must still be honoured",
  );

  assert.equal(evaluate('sanitizeTargetLanguage("ja")'), "ja");
  assert.equal(evaluate('sanitizeTargetLanguage("auto")'), "en");
  assert.equal(evaluate('sanitizeTargetLanguage("not-a-language")'), "en");
  assert.equal(evaluate('sanitizeTargetLanguage("")'), "en");

  assert.equal(
    evaluate("normalizeTranslationSettings({}).targetLanguage"),
    "en",
  );
  assert.equal(evaluate("normalizeTranslationSettings({}).deeplApiKey"), "");

  // The language picker is only useful if it has the app's full list behind it.
  assert.ok(evaluate("WHISPER_LANGUAGE_OPTIONS.length") > 90);
  assert.equal(evaluate("WHISPER_LANGUAGE_OPTIONS[0].code"), "auto");
  assert.ok(
    evaluate('WHISPER_LANGUAGE_OPTIONS.some((option) => option.code === "ja")'),
  );

  console.log("Translation module contract tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
