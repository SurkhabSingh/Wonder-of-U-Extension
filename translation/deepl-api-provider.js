(function initializeDeepLApiProvider(globalScope) {
  "use strict";

  // DeepL's official API, used when the user supplies a key. No tab, no DOM, no
  // rendering — so unlike the page providers this keeps working with the browser
  // minimized, and it cannot be broken by a DeepL redesign.
  //
  // The free-vs-Pro host split lives in utils.js, because the popup has to ask
  // for the matching host permission and must not disagree with us about which
  // one that is.
  const REQUEST_TIMEOUT_MS = 20000;

  // DeepL wants a regional variant for a few target languages and rejects the
  // bare code. Anything not listed here passes through upper-cased.
  const TARGET_LANGUAGE_OVERRIDES = {
    en: "EN-US",
    pt: "PT-PT",
  };

  const endpointForKey = (apiKey) => deeplApiEndpointForKey(apiKey);
  const hostPermissionForKey = (apiKey) => deeplApiHostPermissionForKey(apiKey);

  function toDeepLTarget(language) {
    const normalized = String(language || "en").trim().toLowerCase();
    return TARGET_LANGUAGE_OVERRIDES[normalized] || normalized.toUpperCase();
  }

  function failure(message) {
    return {
      providerId: "deepl",
      translatedText: "",
      errorText: message,
    };
  }

  function describeStatus(status) {
    if (status === 403) {
      return "DeepL rejected the API key.";
    }
    if (status === 429) {
      return "DeepL is rate limiting this key. Try again shortly.";
    }
    if (status === 456) {
      return "The DeepL API quota for this key is used up.";
    }
    return `DeepL returned status ${status}.`;
  }

  async function capture(sourceText, options = {}) {
    const text = String(sourceText || "").trim();

    if (!text) {
      return failure("The transcript was empty.");
    }

    const settings = await getTranslationSettings();
    const apiKey = String(settings.deeplApiKey || "").trim();

    if (!apiKey) {
      return failure("A DeepL API key is required.");
    }

    const hostPermission = hostPermissionForKey(apiKey);
    const granted = await chrome.permissions.contains({
      origins: [hostPermission],
    });

    if (!granted) {
      return failure(
        "DeepL API permission is missing. Re-save the API key in the popup to grant it.",
      );
    }

    const sourceLang = String(options.sourceLang || "").trim().toLowerCase();
    const body = {
      text: [text],
      target_lang: toDeepLTarget(options.targetLang),
    };

    if (sourceLang && sourceLang !== "auto") {
      body.source_lang = sourceLang.toUpperCase();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpointForKey(apiKey), {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        return failure(describeStatus(response.status));
      }

      const payload = await response.json().catch(() => null);
      const translatedText = (payload?.translations || [])
        .map((translation) => String(translation?.text || ""))
        .join("\n")
        .trim();

      if (!translatedText) {
        return failure("DeepL returned an empty result.");
      }

      return {
        providerId: "deepl",
        translatedText,
        errorText: "",
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        return failure("DeepL did not respond in time.");
      }

      return failure(error?.message || "DeepL could not be reached.");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  globalScope.DeepLApiProvider = Object.freeze({
    id: "deepl",
    config: { label: "DeepL", hostPermission: "https://www.deepl.com/*" },
    capture,
    endpointForKey,
    hostPermissionForKey,
    toDeepLTarget,
  });
})(self);
