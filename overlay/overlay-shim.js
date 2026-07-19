(function initializeSubtitleOverlayShim(globalScope) {
  "use strict";

  // Owns registration of the subtitle-mining overlay content script. The overlay
  // needs to run inside the cross-origin player iframe (that is where the <video>
  // lives), which is only reachable with the broad `<all_urls>` host permission —
  // activeTab reaches only the top frame (proven by the detection spike). So this
  // registers the overlay across all frames ONLY while `<all_urls>` is granted,
  // and tears it down the moment it is revoked. Mirrors translation/provider-shim.js,
  // with two deliberate differences: allFrames:true (players are in iframes) and
  // world:"ISOLATED" (share the DOM to read currentTime + draw the overlay, but
  // stay invisible to the page's own scripts and their anti-DevTools traps).

  const OVERLAY_ID = "wonder-subtitle-overlay";
  const OVERLAY_FILES = [
    "overlay/subtitle-parser.js",
    "overlay/subtitle-overlay.js",
  ];
  const ALL_URLS = "<all_urls>";

  let lastError = "";

  async function hasBroadHostAccess() {
    try {
      return await chrome.permissions.contains({ origins: [ALL_URLS] });
    } catch (_) {
      return false;
    }
  }

  async function registeredScript() {
    const [existing] = await chrome.scripting
      .getRegisteredContentScripts({ ids: [OVERLAY_ID] })
      .catch(() => []);

    return existing || null;
  }

  function overlayRegistration() {
    return {
      id: OVERLAY_ID,
      js: OVERLAY_FILES,
      matches: [ALL_URLS],
      allFrames: true,
      runAt: "document_idle",
      world: "ISOLATED",
      persistAcrossSessions: true,
    };
  }

  // Idempotent and cheap. Called on startup and whenever host permissions change,
  // so a registration that quietly failed once cannot stay failed for the profile.
  async function sync() {
    try {
      const granted = await hasBroadHostAccess();
      const existing = await registeredScript();

      if (!granted) {
        if (existing) {
          await chrome.scripting.unregisterContentScripts({ ids: [OVERLAY_ID] });
        }
        lastError = "";
        return { registered: false };
      }

      if (existing) {
        await chrome.scripting.updateContentScripts([overlayRegistration()]);
      } else {
        await chrome.scripting.registerContentScripts([overlayRegistration()]);
      }

      lastError = "";
      return { registered: true };
    } catch (error) {
      // A stale or half-registered script can wedge both register and update; tear
      // it down and try once from clean before giving up.
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [OVERLAY_ID] });
        if (await hasBroadHostAccess()) {
          await chrome.scripting.registerContentScripts([overlayRegistration()]);
          lastError = "";
          return { registered: true };
        }
      } catch (retryError) {
        lastError = String(retryError?.message || retryError || "");
      }

      lastError = lastError || String(error?.message || error || "");
      console.warn("Subtitle overlay shim could not be registered:", lastError);
      return { registered: false, error: lastError };
    }
  }

  globalScope.SubtitleOverlayShim = Object.freeze({
    id: OVERLAY_ID,
    files: OVERLAY_FILES,
    sync,
    getLastError: () => lastError,
  });
})(self);
