(function initializeProviderVisibilityShim(globalScope) {
  "use strict";

  // Owns registration of translation/page-visibility-shim.js on the provider pages.
  //
  // This is not a nicety — it is the single thing that makes Google Translate work
  // in the background tab we drive. Measured in a real Chrome, on a genuinely
  // hidden tab:
  //
  //   Google, shim off -> nothing after 45s
  //   Google, shim on  -> translated in 2s
  //   DeepL,  either   -> translated in ~5s
  //
  // The reason is that Google commits its result through requestAnimationFrame,
  // which Chrome suspends entirely in a hidden tab, while DeepL writes straight to
  // the DOM and does not care. So if this registration silently fails, Google
  // silently stops working and nothing else does — which is exactly the failure we
  // shipped. Registration is therefore re-asserted before every capture, verified
  // from inside the page afterwards, and repaired if it did not take.

  const SHIM_ID = "wonder-provider-visibility-shim";
  const SHIM_FILE = "translation/page-visibility-shim.js";
  // Marker on <html>, not a window property. The shim runs in the page's MAIN
  // world and the automation runs in the extension's ISOLATED world; those have
  // separate `window` objects but share one DOM, so this is the only signal that
  // crosses between them.
  const SHIM_MARKER_ATTRIBUTE = "data-wonder-of-u-shim";

  let lastError = "";

  async function grantedProviderMatches() {
    const matches = [];

    for (const provider of KNOWN_TRANSLATION_PROVIDERS) {
      const granted = await chrome.permissions.contains({
        origins: [provider.hostPermission],
      });

      if (granted) {
        matches.push(provider.hostPermission);
      }
    }

    return matches;
  }

  async function registeredScript() {
    const [existing] = await chrome.scripting
      .getRegisteredContentScripts({ ids: [SHIM_ID] })
      .catch(() => []);

    return existing || null;
  }

  // Idempotent and cheap. Called on startup, on permission changes, and again
  // immediately before every capture, because a registration that quietly failed
  // once must not stay failed for the life of the profile.
  async function sync() {
    try {
      const matches = await grantedProviderMatches();
      const existing = await registeredScript();

      if (!matches.length) {
        if (existing) {
          await chrome.scripting.unregisterContentScripts({ ids: [SHIM_ID] });
        }

        lastError = "";
        return { registered: false, matches: [] };
      }

      const script = {
        id: SHIM_ID,
        js: [SHIM_FILE],
        matches,
        runAt: "document_start",
        world: "MAIN",
        persistAcrossSessions: true,
      };

      if (existing) {
        await chrome.scripting.updateContentScripts([script]);
      } else {
        await chrome.scripting.registerContentScripts([script]);
      }

      lastError = "";
      return { registered: true, matches };
    } catch (error) {
      // A stale or half-registered script can wedge both register and update.
      // Tear it down and try once from clean before giving up.
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [SHIM_ID] });
        const matches = await grantedProviderMatches();

        if (matches.length) {
          await chrome.scripting.registerContentScripts([
            {
              id: SHIM_ID,
              js: [SHIM_FILE],
              matches,
              runAt: "document_start",
              world: "MAIN",
              persistAcrossSessions: true,
            },
          ]);

          lastError = "";
          return { registered: true, matches };
        }
      } catch (retryError) {
        lastError = String(retryError?.message || retryError || "");
      }

      lastError = lastError || String(error?.message || error || "");
      console.warn("Provider visibility shim could not be registered:", lastError);
      return { registered: false, matches: [], error: lastError };
    }
  }

  globalScope.ProviderVisibilityShim = Object.freeze({
    id: SHIM_ID,
    file: SHIM_FILE,
    markerAttribute: SHIM_MARKER_ATTRIBUTE,
    sync,
    getLastError: () => lastError,
  });
})(self);
