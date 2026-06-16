(function initializeTranslationService(globalScope) {
  "use strict";

  const providers = new Map();

  function register(provider) {
    if (!provider?.id || typeof provider.capture !== "function") {
      throw new Error("Translation providers require an id and capture method.");
    }

    providers.set(provider.id, provider);
  }

  async function capture(providerId, sourceText) {
    const provider = providers.get(providerId);
    if (!provider) {
      return {
        providerId,
        translatedText: "",
        errorText: `Translation provider "${providerId}" is unavailable.`,
      };
    }

    return provider.capture(sourceText);
  }

  register(globalScope.GoogleTranslateProvider);

  globalScope.TranslationService = Object.freeze({
    capture,
    hasProvider(providerId) {
      return providers.has(providerId);
    },
  });
})(self);
