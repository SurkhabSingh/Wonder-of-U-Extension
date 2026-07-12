"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const context = vm.createContext({
  console,
  clearTimeout,
  setTimeout,
  // utils.js parses endpoints with `new URL(...)`; without it here every parse
  // throws and sanitizeBridgeEndpoint silently returns its default, which would
  // make the endpoint assertions below pass for the wrong reason.
  URL,
  chrome: {
    permissions: {
      contains: async () => false,
    },
  },
});

context.self = context;

for (const relativePath of [
  "utils.js",
  "translation/provider-automation.js",
  "translation/google-translate-provider.js",
  "translation/deepl-translate-provider.js",
  "translation/translation-service.js",
]) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  vm.runInContext(source, context, { filename: relativePath });
}

async function run() {
  // Both providers register through the shared service.
  assert.equal(context.TranslationService.hasProvider("google-translate"), true);
  assert.equal(context.TranslationService.hasProvider("deepl"), true);

  const providerIds = Array.from(
    context.TranslationService.listProviders(),
    (provider) => provider.id,
  ).sort();
  assert.deepEqual(providerIds, ["deepl", "google-translate"]);

  // Google keeps its heuristic anchor fallback under the new config shape.
  assert.equal(
    context.GoogleTranslateProvider.config.selectors.output.anchorText,
    "Send feedback",
  );
  assert.equal(
    context.GoogleTranslateProvider.config.selectors.input,
    '[aria-label="Source text"]',
  );

  // DeepL uses the supplied selectors in plain-text output mode. The input must
  // reach the contenteditable *inside* the <d-textarea>: the element carrying
  // data-testid is a custom element we cannot type into.
  assert.equal(context.DeepLTranslateProvider.config.selectors.output.mode, "text");
  assert.equal(
    context.DeepLTranslateProvider.config.selectors.input,
    '[data-testid="translator-source-input"] div[contenteditable="true"]',
  );
  assert.match(
    context.DeepLTranslateProvider.config.selectors.output.selector,
    /contenteditable="true"\] p$/,
  );
  assert.ok(
    context.DeepLTranslateProvider.config.selectors.output.fallbackSelector,
    "DeepL needs an output fallback for translations rendered without <p>",
  );
  assert.equal(
    context.DeepLTranslateProvider.config.url,
    "https://www.deepl.com/en/translator",
  );

  // utils.js exposes these as top-level `const`s, which are lexical bindings in
  // the context rather than properties on it, so they have to be read by
  // evaluating inside the context.
  const evaluate = (expression) => vm.runInContext(expression, context);

  // The bridge must not sit on a port Anki already owns: 8765 is AnkiConnect and
  // 8766 is the furigana add-on. Pointing there means the extension long-polls
  // Anki, which answers /v1/* with 404 and reads as "bridge not connected".
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

  // The language picker is only useful if it has the app's full list behind it.
  assert.ok(evaluate("WHISPER_LANGUAGE_OPTIONS.length") > 90);
  assert.equal(evaluate("WHISPER_LANGUAGE_OPTIONS[0].code"), "auto");
  assert.ok(
    evaluate('WHISPER_LANGUAGE_OPTIONS.some((option) => option.code === "ja")'),
  );

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

  console.log("Translation module contract tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
