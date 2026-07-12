// Runs in the provider page's MAIN world at document_start (registered from
// background.js once the provider host permission is granted).
//
// Chrome suspends requestAnimationFrame and throttles timers in background
// tabs. Google Translate and DeepL both commit their rendering through rAF, so
// in a hidden tab the translated text is never written to the DOM and our
// automation times out — the translation only appears once the user focuses the
// tab. This shim presents the page as visible and reschedules its frame
// callbacks onto timers, so the page keeps rendering while the tab is hidden.
(function installProviderVisibilityShim() {
  "use strict";

  if (window.__wonderOfUVisibilityShim) {
    return;
  }
  window.__wonderOfUVisibilityShim = true;

  // Captured before we override anything, so the shim can still tell whether the
  // tab is *really* hidden and leave the native rAF in charge when it is not.
  const nativeVisibility = Object.getOwnPropertyDescriptor(
    Document.prototype,
    "visibilityState",
  );

  function isReallyHidden() {
    try {
      return nativeVisibility?.get?.call(document) === "hidden";
    } catch {
      return false;
    }
  }

  function forceGetter(target, property, value) {
    try {
      Object.defineProperty(target, property, {
        configurable: true,
        get: () => value,
      });
    } catch {
      // A page may have already sealed the property; the rAF shim below is the
      // part that actually keeps rendering alive, so this is not fatal.
    }
  }

  forceGetter(document, "hidden", false);
  forceGetter(document, "visibilityState", "visible");
  forceGetter(document, "webkitHidden", false);
  forceGetter(document, "webkitVisibilityState", "visible");

  document.hasFocus = () => true;

  // The page now reports itself visible, but a listener that pauses work purely
  // on the event (without re-reading visibilityState) would still stop.
  const swallowVisibilityChange = (event) => {
    event.stopImmediatePropagation();
  };
  document.addEventListener("visibilitychange", swallowVisibilityChange, true);
  window.addEventListener("visibilitychange", swallowVisibilityChange, true);

  const nativeRequestFrame = window.requestAnimationFrame?.bind(window);
  const nativeCancelFrame = window.cancelAnimationFrame?.bind(window);

  // Our handles live above any plausible native handle so cancelAnimationFrame
  // can route each one back to whichever scheduler issued it.
  const SHIM_HANDLE_BASE = 1e9;
  const FRAME_INTERVAL_MS = 16;
  const shimTimers = new Map();
  let nextShimHandle = SHIM_HANDLE_BASE;

  window.requestAnimationFrame = function requestAnimationFrame(callback) {
    if (typeof callback !== "function") {
      return 0;
    }

    if (!isReallyHidden() && nativeRequestFrame) {
      return nativeRequestFrame(callback);
    }

    const handle = (nextShimHandle += 1);
    const timerId = setTimeout(() => {
      shimTimers.delete(handle);
      callback(performance.now());
    }, FRAME_INTERVAL_MS);

    shimTimers.set(handle, timerId);
    return handle;
  };

  window.cancelAnimationFrame = function cancelAnimationFrame(handle) {
    if (shimTimers.has(handle)) {
      clearTimeout(shimTimers.get(handle));
      shimTimers.delete(handle);
      return;
    }

    nativeCancelFrame?.(handle);
  };
})();
