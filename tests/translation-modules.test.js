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
  chrome: {
    permissions: {
      contains: async () => false,
    },
  },
});

context.self = context;

for (const relativePath of [
  "translation/google-translate-provider.js",
  "translation/translation-service.js",
]) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
  vm.runInContext(source, context, { filename: relativePath });
}

async function run() {
  assert.equal(
    context.TranslationService.hasProvider("google-translate"),
    true,
  );
  assert.equal(
    context.GoogleTranslateProvider.config.selectors.outputAnchorText,
    "Send feedback",
  );

  const unknownProviderResult = await context.TranslationService.capture(
    "missing-provider",
    "hello",
  );
  assert.match(unknownProviderResult.errorText, /unavailable/i);

  const emptyInputResult = await context.TranslationService.capture(
    "google-translate",
    " ",
  );
  assert.equal(emptyInputResult.translatedText, "");
  assert.match(emptyInputResult.errorText, /empty/i);

  const missingPermissionResult = await context.TranslationService.capture(
    "google-translate",
    "hello",
  );
  assert.equal(missingPermissionResult.translatedText, "");
  assert.match(missingPermissionResult.errorText, /permission/i);

  console.log("Translation module contract tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
