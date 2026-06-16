(function initializeBrowserTabCaptureProvider(globalScope) {
  "use strict";

  const DEFAULT_VIDEO_BITS_PER_SECOND = 12000000;
  const DEFAULT_AUDIO_BITS_PER_SECOND = 320000;
  const DEFAULT_SAMPLE_DURATION_MS = 5000;

  async function startAudioCapture(options) {
    const dependencies = validateDependencies(options);
    const targetTabId = validateTabId(options.targetTabId);

    await dependencies.prepare();
    const streamId = await getMediaStreamId(targetTabId);

    return dependencies.send({
      type: "start-recording",
      streamId,
      format: options.format,
      transcriptionEnabled: Boolean(options.transcriptionEnabled),
    });
  }

  async function stopCapture(options) {
    const dependencies = validateDependencies(options, {
      prepareRequired: false,
    });

    return dependencies.send({
      type: "stop-recording",
    });
  }

  async function recordAvSample(options) {
    const dependencies = validateDependencies(options);
    const targetTabId = validateTabId(options.targetTabId);

    await dependencies.prepare();
    const streamId = await getMediaStreamId(targetTabId);

    return dependencies.send({
      type: "record-av-test",
      streamId,
      durationMs: sanitizeDuration(options.durationMs),
      videoBitsPerSecond: sanitizeBitrate(
        options.videoBitsPerSecond,
        DEFAULT_VIDEO_BITS_PER_SECOND,
      ),
      audioBitsPerSecond: sanitizeBitrate(
        options.audioBitsPerSecond,
        DEFAULT_AUDIO_BITS_PER_SECOND,
      ),
    });
  }

  async function getMediaStreamId(targetTabId) {
    return chrome.tabCapture.getMediaStreamId({
      targetTabId,
    });
  }

  function validateDependencies(options, validationOptions = {}) {
    if (!options || typeof options.send !== "function") {
      throw new Error("Browser tab capture requires an offscreen send method.");
    }

    if (
      validationOptions.prepareRequired !== false &&
      typeof options.prepare !== "function"
    ) {
      throw new Error(
        "Browser tab capture requires an offscreen preparation method.",
      );
    }

    return {
      prepare: options.prepare,
      send: options.send,
    };
  }

  function validateTabId(value) {
    const tabId = Number(value);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new Error("A valid target tab is required for browser capture.");
    }

    return tabId;
  }

  function sanitizeDuration(value) {
    const durationMs = Number(value);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return DEFAULT_SAMPLE_DURATION_MS;
    }

    return Math.min(Math.max(durationMs, 1000), 30000);
  }

  function sanitizeBitrate(value, fallback) {
    const bitrate = Number(value);
    return Number.isFinite(bitrate) && bitrate > 0 ? bitrate : fallback;
  }

  globalScope.BrowserTabCaptureProvider = Object.freeze({
    id: "browser-tab",
    startAudioCapture,
    stopCapture,
    recordAvSample,
  });
})(self);
