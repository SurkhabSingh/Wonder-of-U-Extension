(function initializeTranslationBridgeClient(globalScope) {
  "use strict";

  // Client half of the Wonder of U translation bridge. See translation/BRIDGE.md.
  //
  // The extension used to long-poll the desktop app over HTTP from this service
  // worker. That could not be made reliable: Chrome terminates an MV3 service
  // worker after 30 seconds of inactivity, and an in-flight `fetch()` is neither
  // an event nor an extension API call, so it does not reset that timer. While
  // the user was browsing, unrelated events kept the worker alive by accident;
  // minimize the window and the worker died mid-poll, taking the connection (and
  // any claimed job) with it.
  //
  // So the HTTP now lives in the native host, and we talk to it over a
  // `connectNative` port — the one long-lived connection Chrome documents as
  // keeping a service worker alive, cancelling both the idle timeout and the
  // 5-minute cap. The worker keeps only the part that actually needs a browser:
  // driving the provider page.

  const NATIVE_BRIDGE_HOST = "com.audio_recorder.whisper_host";
  const MIN_RECONNECT_DELAY_MS = 1000;
  const MAX_RECONNECT_DELAY_MS = 30000;

  let port = null;
  let running = false;
  let reconnectFailures = 0;
  let reconnectTimer = null;
  let endpoint = DEFAULT_BRIDGE_ENDPOINT;

  const status = {
    running: false,
    connected: false,
    endpoint,
    version: "",
    lastError: "",
    lastJobAt: null,
  };

  // The popup must be able to tell "the app is not running" from "the worker was
  // restarted a moment ago and has not reconnected yet". In-memory state cannot:
  // it dies with the worker. Session storage survives the restart and is cleared
  // when the browser closes, which is exactly the lifetime we want.
  function persistStatus() {
    return chrome.storage.session
      .set({ bridgeStatus: { ...status } })
      .catch(() => {});
  }

  function setStatus(patch) {
    Object.assign(status, patch);
    return persistStatus();
  }

  function getStatus() {
    return { ...status, endpoint };
  }

  async function restoreStatus() {
    try {
      const stored = await chrome.storage.session.get("bridgeStatus");
      if (stored?.bridgeStatus) {
        Object.assign(status, stored.bridgeStatus, {
          running,
          connected: false,
        });
      }
    } catch {
      // Session storage is unavailable; the live port will repopulate status.
    }
  }

  function configure(options = {}) {
    if (!options.endpoint) {
      return false;
    }

    const sanitized = sanitizeBridgeEndpoint(options.endpoint);
    const changed = sanitized !== endpoint;
    endpoint = sanitized;
    status.endpoint = sanitized;

    return changed;
  }

  function start(options = {}) {
    const endpointChanged = configure(options);

    if (running && !endpointChanged) {
      // Already connected (or mid-reconnect) against the same host. The alarm
      // watchdog calls this every 30s, so it has to be a cheap no-op.
      ensurePort();
      return;
    }

    if (endpointChanged && running) {
      teardownPort();
    }

    running = true;
    status.running = true;
    ensurePort();
  }

  function stop() {
    running = false;
    status.running = false;
    reconnectFailures = 0;
    teardownPort();
    setStatus({ connected: false, version: "", lastError: "" });
  }

  function teardownPort() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (!port) {
      return;
    }

    const closing = port;
    port = null;

    try {
      closing.postMessage({ type: "bridge-stop" });
    } catch {
      // The port is already gone.
    }

    try {
      closing.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  function ensurePort() {
    if (port || !running) {
      return;
    }

    try {
      port = chrome.runtime.connectNative(NATIVE_BRIDGE_HOST);
    } catch (error) {
      port = null;
      setStatus({
        connected: false,
        lastError: describeNativeHostError(error),
      });
      scheduleReconnect();
      return;
    }

    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(handleDisconnect);

    try {
      port.postMessage({ type: "bridge-start", endpoint });
    } catch (error) {
      handleDisconnect();
    }
  }

  function handleDisconnect() {
    const failure = chrome.runtime.lastError;
    port = null;

    if (!running) {
      return;
    }

    setStatus({
      connected: false,
      version: "",
      lastError: failure
        ? describeNativeHostError(failure)
        : "The Wonder of U helper stopped. Reconnecting...",
    });

    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer !== null) {
      return;
    }

    reconnectFailures += 1;
    const capped = Math.min(
      MAX_RECONNECT_DELAY_MS,
      MIN_RECONNECT_DELAY_MS * 2 ** (reconnectFailures - 1),
    );
    const delay = Math.round(capped / 2 + Math.random() * (capped / 2));

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensurePort();
    }, delay);
  }

  function handlePortMessage(message) {
    if (message?.type === "bridge-status") {
      if (message.connected) {
        reconnectFailures = 0;
      }

      setStatus({
        connected: Boolean(message.connected),
        version: String(message.version || ""),
        lastError: String(message.lastError || ""),
      });
      return;
    }

    if (message?.type === "bridge-heartbeat") {
      // Receiving this resets the service worker's idle timer, which is the
      // point. Persisting keeps the popup's view fresh across a restart.
      persistStatus();
      return;
    }

    if (message?.type === "bridge-job" && message.job) {
      handleJob(message.job);
    }
  }

  async function handleJob(job) {
    let providerId = String(job.provider || "").trim();

    if (!providerId) {
      const settings = await getTranslationSettings();
      providerId = settings.provider;
    }

    try {
      const result = await globalScope.TranslationService.capture(
        providerId,
        job.sourceText,
        {
          sourceLang: job.sourceLang,
          targetLang: job.targetLang,
        },
      );

      if (result.translatedText) {
        postToPort({
          type: "bridge-result",
          id: job.id,
          translatedText: result.translatedText,
        });
        await setStatus({ lastJobAt: Date.now() });
        return;
      }

      postToPort({
        type: "bridge-fail",
        id: job.id,
        error: result.errorText || "The provider returned no translation.",
      });
    } catch (error) {
      postToPort({
        type: "bridge-fail",
        id: job.id,
        error: error?.message || "Translation job failed.",
      });
    }
  }

  function postToPort(message) {
    if (!port) {
      return;
    }

    try {
      port.postMessage(message);
    } catch {
      // The port died while we were translating. The native host times the job
      // out and reports it back to the app, so nothing is left hanging.
    }
  }

  function describeNativeHostError(error) {
    const message = String(error?.message || error || "");

    if (
      message.includes("native messaging host not found") ||
      message.includes("Specified native messaging host not found")
    ) {
      return "Wonder of U helper is not installed. Run install-native-host.ps1 with your extension ID, then reload the extension.";
    }

    if (message.includes("forbidden")) {
      return "The Wonder of U helper does not allow this extension ID. Re-run install-native-host.ps1.";
    }

    return message || "The Wonder of U helper could not be reached.";
  }

  // Used by the popup's Reconnect button: drop the port and rebuild it now,
  // rather than waiting out the backoff.
  function reconnect() {
    if (!running) {
      return getStatus();
    }

    teardownPort();
    reconnectFailures = 0;
    ensurePort();

    return getStatus();
  }

  globalScope.TranslationBridgeClient = Object.freeze({
    protocolVersion: "1",
    configure,
    start,
    stop,
    getStatus,
    restoreStatus,
    reconnect,
  });
})(self);
