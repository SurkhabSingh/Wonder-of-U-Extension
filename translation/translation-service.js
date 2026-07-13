(function initializeTranslationService(globalScope) {
  "use strict";

  const providers = new Map();

  function register(provider) {
    if (!provider?.id || typeof provider.capture !== "function") {
      throw new Error("Translation providers require an id and capture method.");
    }

    providers.set(provider.id, provider);
  }

  // DeepL has two implementations behind one id: an HTTP provider when the user
  // has supplied an API key, and page automation when they have not. The key path
  // needs no tab, so it is immune to everything Chrome does to hidden tabs — if a
  // translation must not fail, that is the one to use.
  async function resolveProvider(providerId) {
    if (providerId === "deepl" && globalScope.DeepLApiProvider) {
      const settings = await getTranslationSettings();

      if (String(settings.deeplApiKey || "").trim()) {
        return globalScope.DeepLApiProvider;
      }
    }

    return providers.get(providerId) || null;
  }

  async function capture(providerId, sourceText, options = {}) {
    const provider = await resolveProvider(providerId);

    if (!provider) {
      return {
        providerId,
        translatedText: "",
        errorText: `Translation provider "${providerId}" is unavailable.`,
      };
    }

    return provider.capture(sourceText, options);
  }

  register(globalScope.GoogleTranslateProvider);
  register(globalScope.DeepLTranslateProvider);

  globalScope.TranslationService = Object.freeze({
    capture,
    resolveProvider,
    hasProvider(providerId) {
      return providers.has(providerId);
    },
    listProviders() {
      return Array.from(providers.values()).map((provider) => ({
        id: provider.id,
        label: provider.config?.label || provider.id,
        hostPermission: provider.config?.hostPermission || "",
      }));
    },
  });
})(self);
