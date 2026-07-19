importScripts(
  "utils.js",
  "capture/browser-tab-capture-provider.js",
  "translation/provider-shim.js",
  "translation/provider-automation.js",
  "translation/google-translate-provider.js",
  "translation/deepl-translate-provider.js",
  "translation/deepl-api-provider.js",
  "translation/translation-service.js",
  "translation/bridge-client.js",
  "overlay/overlay-shim.js",
);

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const NATIVE_TRANSCRIBER_HOST = "com.audio_recorder.whisper_host";
// The native port keeps this worker alive while it is connected, but nothing can
// revive a worker that Chrome already tore down (say, while the bridge host was
// unreachable and the port was closed). An alarm is the only thing that can:
// alarms wake a dead worker, and 30s is the shortest period Chrome allows.
const BRIDGE_WATCHDOG_ALARM = "wonder-bridge-watchdog";
const BRIDGE_WATCHDOG_PERIOD_MINUTES = 0.5;
const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
let offscreenCreationPromise = null;

initializeExtension().catch((error) => {
  console.error("Initialization failed:", error);
});

chrome.runtime.onStartup.addListener(() => {
  initializeExtension().catch((error) => {
    console.error("Startup initialization failed:", error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension().catch((error) => {
    console.error("Install initialization failed:", error);
  });
});

chrome.permissions.onAdded.addListener(() => {
  syncProviderVisibilityShim().catch((error) => {
    console.warn("Could not register the provider visibility shim:", error);
  });
  // Granting <all_urls> (from the Watch & Mine toggle) registers the overlay
  // across all frames the instant the permission lands.
  syncSubtitleOverlayShim().catch((error) => {
    console.warn("Could not register the subtitle overlay shim:", error);
  });
});

chrome.permissions.onRemoved.addListener(() => {
  syncProviderVisibilityShim().catch((error) => {
    console.warn("Could not update the provider visibility shim:", error);
  });
  syncSubtitleOverlayShim().catch((error) => {
    console.warn("Could not update the subtitle overlay shim:", error);
  });
  // Revoking the loopback permission has to stop the bridge too, or it keeps
  // retrying against a host it is no longer allowed to reach.
  syncBridgeClient().catch((error) => {
    console.warn("Could not synchronize translation bridge:", error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_WATCHDOG_ALARM) {
    return;
  }

  syncBridgeClient().catch((error) => {
    console.warn("Bridge watchdog could not restore the connection:", error);
  });
});

// The subtitle overlay scopes its cues per tab under this key; the content script
// builds the same `subtitleCues_<tabId>` key. Clear a tab's cues when it navigates
// to a new page (a new episode — full load or SPA URL change) or is closed, so a
// subtitle loaded on one video never bleeds onto the next.
const SUBTITLE_CUES_KEY_PREFIX = "subtitleCues_";

function clearTabSubtitleCues(tabId) {
  if (typeof tabId !== "number") {
    return;
  }
  chrome.storage.session
    .remove(`${SUBTITLE_CUES_KEY_PREFIX}${tabId}`)
    .catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    clearTabSubtitleCues(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabSubtitleCues(tabId);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "auto-sync-subtitles") {
    // A command press grants activeTab for the active tab, which tabCapture needs.
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab?.id) {
      startAutoSyncForTab(tab.id);
    }
    return;
  }

  try {
    if (command === "start-recording") {
      await startRecording();
    }

    if (command === "stop-recording") {
      await stopRecording();
    }
  } catch (error) {
    await handleRecordingError(error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }

  if (
    message?.action === "START" ||
    message?.action === "STOP" ||
    message?.action === "BROWSE_PATH" ||
    message?.action === "FLUSH_QUEUE" ||
    message?.action === "GET_QUEUE_STATUS" ||
    message?.action === "GET_QUEUE_ITEMS" ||
    message?.action === "DROP_QUEUE_ITEM" ||
    message?.action === "START_AV_TEST" ||
    message?.action === "DETECT_VIDEOS" ||
    message?.action === "GET_TAB_ID" ||
    message?.action === "JIMAKU_SEARCH" ||
    message?.action === "JIMAKU_FILES" ||
    message?.action === "JIMAKU_DOWNLOAD" ||
    message?.action === "RUN_AUTOSYNC" ||
    message?.action === "GET_APP_MODE" ||
    message?.action === "SET_APP_MODE" ||
    message?.action === "GET_BRIDGE_STATUS" ||
    message?.action === "RECONNECT_BRIDGE" ||
    message?.action === "LIST_ANKI_DECKS" ||
    message?.action === "LIST_ANKI_NOTE_TYPES" ||
    message?.action === "LIST_ANKI_FIELDS"
  ) {
    handleControlMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch(async (error) => {
        console.error("Control message failed:", error);
        if (message?.action === "START" || message?.action === "STOP") {
          await handleRecordingError(error);
        }
        sendResponse({
          ok: false,
          error: error.message || "Unexpected extension error.",
        });
      });

    return true;
  }

  if (message?.type === "autosync-started") {
    // Relayed from the offscreen doc to the tab, so it can read video.currentTime
    // at the true capture-start moment. tabId travels in the message so this works
    // even if the SW was restarted mid-capture.
    if (message.tabId != null) {
      chrome.tabs
        .sendMessage(message.tabId, { type: "autosync-started" })
        .catch(() => {});
    }
    return false;
  }

  if (message?.type === "autosync-clip") {
    // The offscreen doc captured a short clip; transcribe it via the native host
    // and push the timestamped segments to the tab's overlay for text matching.
    handleAutoSyncClip(message);
    return false;
  }

  if (message?.type === "autosync-complete") {
    // Now only carries capture-stage errors (success arrives as autosync-clip).
    if (message.tabId != null && message.error) {
      chrome.tabs
        .sendMessage(message.tabId, {
          type: "autosync-error",
          error: message.error,
        })
        .catch(() => {});
    }
    return false;
  }

  if (message?.type === "recording-complete") {
    handleRecorderCompleteEvent(message);
    return false;
  }

  if (
    message?.type === "recording-started" ||
    message?.type === "recording-error"
  ) {
    handleRecorderEvent(message).catch(async (error) => {
      console.error("Recorder event failed:", error);
      await handleRecordingError(error);
    });
  }

  return false;
});

async function handleControlMessage(message, sender) {
  if (!message) {
    return { ok: false, error: "Empty message." };
  }

  if (message.action === "GET_TAB_ID") {
    // Content scripts can't read their own tab id; the subtitle overlay needs it
    // to scope its cues to this tab (so a subtitle loaded on one video doesn't
    // bleed onto every other tab). The tab title seeds the Jimaku search (the
    // anime name is on the top page, which the player iframe can't read).
    return {
      ok: true,
      tabId: sender?.tab?.id ?? null,
      title: sender?.tab?.title ?? "",
    };
  }

  if (message.action === "START") {
    await startRecording(message.tabId);
    return { ok: true };
  }

  if (message.action === "STOP") {
    await stopRecording();
    return { ok: true };
  }

  if (message.action === "BROWSE_PATH") {
    const selectedPath = await requestNativePathSelection({
      kind: message.pathKind,
      currentPath: message.currentPath,
    });

    return {
      ok: true,
      cancelled: !selectedPath,
      path: selectedPath || "",
    };
  }

  if (message.action === "START_AV_TEST") {
    return startAvCaptureTest({
      tabId: message.tabId,
      videoBitsPerSecond: message.videoBitsPerSecond,
      audioBitsPerSecond: message.audioBitsPerSecond,
    });
  }

  if (message.action === "DETECT_VIDEOS") {
    return runVideoDetection(message.tabId);
  }

  if (message.action === "JIMAKU_SEARCH") {
    return jimakuSearch(message);
  }

  if (message.action === "JIMAKU_FILES") {
    return jimakuFiles(message);
  }

  if (message.action === "JIMAKU_DOWNLOAD") {
    return jimakuDownload(message);
  }

  if (message.action === "RUN_AUTOSYNC") {
    // Triggered from the popup, whose click grants the activeTab that tabCapture
    // requires. Fire-and-forget: the result is pushed to the tab's overlay.
    startAutoSyncForTab(message.tabId);
    return { ok: true };
  }

  if (message.action === "LIST_ANKI_DECKS") {
    const response = await requestNativeHostMessage({
      type: "list-anki-decks",
      anki: { connectUrl: ANKI_CONNECT_URL },
    });

    return { ok: true, decks: response.decks || [] };
  }

  if (message.action === "LIST_ANKI_NOTE_TYPES") {
    const response = await requestNativeHostMessage({
      type: "list-anki-note-types",
      anki: { connectUrl: ANKI_CONNECT_URL },
    });

    return { ok: true, noteTypes: response.noteTypes || [] };
  }

  if (message.action === "LIST_ANKI_FIELDS") {
    const response = await requestNativeHostMessage({
      type: "list-anki-fields",
      noteType: message.noteType,
      anki: { connectUrl: ANKI_CONNECT_URL },
    });

    return {
      ok: true,
      noteType: response.noteType || "",
      fields: response.fields || [],
    };
  }

  if (message.action === "GET_APP_MODE") {
    const appMode = await getAppMode();
    return { ok: true, appMode };
  }

  if (message.action === "SET_APP_MODE") {
    const appMode = await setAppMode(message.appMode);
    await syncBridgeClient();
    return { ok: true, appMode };
  }

  if (message.action === "GET_BRIDGE_STATUS") {
    // Reports what the live port knows. It no longer fires its own HTTP probe:
    // the old one raced the poll loop over a shared status object, so the popup
    // and the loop could each overwrite the other's verdict and the UI flapped.
    await syncBridgeClient();
    return { ok: true, status: TranslationBridgeClient.getStatus() };
  }

  if (message.action === "RECONNECT_BRIDGE") {
    return { ok: true, status: TranslationBridgeClient.reconnect() };
  }

  if (message.action === "GET_QUEUE_STATUS") {
    const queueState = await syncAnkiQueueState();
    return { ok: true, queueState };
  }

  if (message.action === "FLUSH_QUEUE") {
    return flushQueuedAnkiCards();
  }

  if (message.action === "GET_QUEUE_ITEMS") {
    const result = await requestNativeQueueItems();
    return { ok: true, items: result.items || [] };
  }

  if (message.action === "DROP_QUEUE_ITEM") {
    const result = await requestNativeDropQueueItem(message.jobId);
    const queueState = await setAnkiQueueState({
      pendingCount: Number(result.pendingCount || 0),
      isSyncing: false,
      statusText: buildQueueCountText(result.pendingCount || 0),
      errorText: "",
      lastUpdatedAt: Date.now(),
    });

    return {
      ok: true,
      queueState,
      items: result.items || [],
    };
  }

  return { ok: false, error: "Unknown control message." };
}

async function handleRecorderEvent(message) {
  if (!message) {
    return;
  }

  if (message.type === "recording-started") {
    await handleRecordingStarted(message.startedAt);
    return;
  }

  if (message.type === "recording-complete") {
    await handleRecordingComplete(message);
    return;
  }

  if (message.type === "recording-error") {
    await handleRecordingError(
      new Error(message.message || "Recording failed."),
    );
  }
}

function handleRecorderCompleteEvent(message) {
  handleRecordingComplete(message)
    .catch(async (error) => {
      console.error("Recorder completion failed:", error);
      await handleRecordingError(error);
    })
    .finally(() => {
      closeOffscreenDocument().catch((error) => {
        console.warn("Could not close offscreen document:", error);
      });
    });
}

async function initializeExtension() {
  await ensureSettings();
  await ensureSessionStorageSharedWithFrames();
  await clearStaleProcessingState();
  await syncAnkiQueueState({ suppressErrors: true });
  await TranslationBridgeClient.restoreStatus();
  await syncBridgeClient().catch((error) => {
    console.warn("Could not synchronize translation bridge:", error);
  });
  await syncProviderVisibilityShim().catch((error) => {
    console.warn("Could not register the provider visibility shim:", error);
  });
  await syncSubtitleOverlayShim().catch((error) => {
    console.warn("Could not register the subtitle overlay shim:", error);
  });
  await sweepOrphanedProviderTabs();
}

// The subtitle overlay shares parsed cues between frames via chrome.storage.session
// (a drop on the top page must reach the player iframe's overlay). Session storage
// is hidden from content scripts by default, so open it to them once at startup.
async function ensureSessionStorageSharedWithFrames() {
  try {
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
    });
  } catch (error) {
    console.warn("Could not expose session storage to content scripts:", error);
  }
}

// Registers the subtitle-mining overlay across all frames while <all_urls> is
// granted, and unregisters it otherwise. The registration itself lives in
// overlay/overlay-shim.js.
async function syncSubtitleOverlayShim() {
  await SubtitleOverlayShim.sync();
}

// A worker killed mid-capture never reaches the `finally` that closes its
// provider tab, so a stray translate.google.com/deepl.com tab can survive the
// restart. The automation records the tabs it owns, so only ours get closed —
// a provider tab the user opened themselves is left alone.
async function sweepOrphanedProviderTabs() {
  try {
    await WonderTranslationAutomation.closeOwnedTabs();
  } catch (error) {
    console.warn("Could not sweep orphaned provider tabs:", error);
  }
}

// Registers the MAIN-world shim on every provider page we have permission for.
// Without it Chrome suspends requestAnimationFrame in the background tab we
// translate in, Google never renders its result, and the capture times out. The
// registration itself lives in translation/provider-shim.js, which also
// re-asserts it before every capture and repairs it if it did not take.
async function syncProviderVisibilityShim() {
  await ProviderVisibilityShim.sync();
}

// Starts the App-Support translation bridge client when the extension is in
// app-support mode, and stops it otherwise. Called on every worker start and
// every watchdog tick, so it must be a cheap no-op when already connected.
async function syncBridgeClient() {
  const appMode = await getAppMode();
  const translationSettings = await getTranslationSettings();

  if (appMode !== "app-support") {
    TranslationBridgeClient.stop();
    await chrome.alarms.clear(BRIDGE_WATCHDOG_ALARM);
    return;
  }

  TranslationBridgeClient.start({
    endpoint: translationSettings.bridgeEndpoint,
  });

  const existing = await chrome.alarms.get(BRIDGE_WATCHDOG_ALARM);
  if (!existing) {
    await chrome.alarms.create(BRIDGE_WATCHDOG_ALARM, {
      periodInMinutes: BRIDGE_WATCHDOG_PERIOD_MINUTES,
    });
  }
}

async function startRecording(tabId) {
  const recorderState = await getRecorderState();
  if (recorderState.isRecording || recorderState.isProcessing) {
    return;
  }

  const targetTabId = tabId || (await getActiveTabId());
  if (!targetTabId) {
    throw new Error("No active tab is available to record.");
  }

  const transcriptionSettings = await getTranscriptionSettings();

  await setRecorderState({
    isRecording: false,
    isProcessing: false,
    startedAt: null,
    stoppedAt: null,
    targetTabId,
    lastDurationMs: 0,
    lastAudioPath: null,
    lastTranscriptPath: null,
    statusText: "Starting recording...",
    errorText: "",
  });

  await BrowserTabCaptureProvider.startAudioCapture({
    targetTabId,
    format: await getFormat(),
    transcriptionEnabled: transcriptionSettings.enabled,
    prepare: ensureOffscreenDocument,
    send: sendOffscreenMessage,
  });
}

async function stopRecording() {
  const recorderState = await getRecorderState();
  if (!recorderState.isRecording || recorderState.isProcessing) {
    return;
  }

  const durationMs = recorderState.startedAt
    ? Math.max(0, Date.now() - recorderState.startedAt)
    : 0;

  await setRecorderState({
    isRecording: false,
    isProcessing: true,
    stoppedAt: Date.now(),
    lastDurationMs: durationMs,
    statusText: "Finishing recording...",
    errorText: "",
  });

  await BrowserTabCaptureProvider.stopCapture({
    send: sendOffscreenMessage,
  });
}

async function startAvCaptureTest(options = {}) {
  const recorderState = await getRecorderState();
  if (recorderState.isRecording || recorderState.isProcessing) {
    throw new Error("A recording or processing job is already active.");
  }

  const targetTabId = options.tabId || (await getActiveTabId());
  if (!targetTabId) {
    throw new Error("No active tab is available to test.");
  }

  await setRecorderState({
    isRecording: false,
    isProcessing: true,
    startedAt: null,
    stoppedAt: null,
    targetTabId,
    lastDurationMs: 5000,
    lastAudioPath: null,
    lastTranscriptPath: null,
    statusText: "Recording A/V capture test...",
    errorText: "",
  });

  let blobId = null;

  try {
    const captureResult = await BrowserTabCaptureProvider.recordAvSample({
      targetTabId,
      durationMs: 5000,
      videoBitsPerSecond: options.videoBitsPerSecond,
      audioBitsPerSecond: options.audioBitsPerSecond,
      prepare: ensureOffscreenDocument,
      send: sendOffscreenMessage,
    });

    if (!captureResult?.ok || !captureResult.blobId) {
      throw new Error(
        captureResult?.error ||
          "The offscreen A/V test did not produce a recording.",
      );
    }

    blobId = captureResult.blobId;
    const blob = await getRecordingBlob(blobId);
    if (!blob) {
      throw new Error("The A/V test recording data could not be loaded.");
    }

    const download = await downloadBlobAndWait(blob, buildAvTestFilename());
    await deleteRecordingBlob(blobId);
    blobId = null;

    await setRecorderState({
      isRecording: false,
      isProcessing: false,
      startedAt: null,
      stoppedAt: Date.now(),
      targetTabId: null,
      lastDurationMs: captureResult.durationMs || 5000,
      lastAudioPath: download.filename,
      lastTranscriptPath: null,
      statusText: `A/V capture test saved to ${download.filename}`,
      errorText: "",
    });

    return {
      ok: true,
      filename: download.filename,
      mimeType: captureResult.mimeType,
      sizeBytes: captureResult.sizeBytes,
      durationMs: captureResult.durationMs,
      actualVideoBitsPerSecond: captureResult.actualVideoBitsPerSecond,
      actualAudioBitsPerSecond: captureResult.actualAudioBitsPerSecond,
      trackSettings: captureResult.trackSettings || [],
    };
  } catch (error) {
    await setRecorderState({
      isRecording: false,
      isProcessing: false,
      startedAt: null,
      stoppedAt: Date.now(),
      targetTabId: null,
      lastDurationMs: 0,
      statusText: "A/V capture test failed",
      errorText: error.message || "The A/V capture test failed.",
    });

    throw error;
  } finally {
    if (blobId) {
      await deleteRecordingBlob(blobId);
    }

    await closeOffscreenDocument().catch((error) => {
      console.warn("Could not close offscreen document after A/V test:", error);
    });
  }
}

async function handleRecordingStarted(startedAt) {
  const state = await setRecorderState({
    isRecording: true,
    isProcessing: false,
    startedAt,
    stoppedAt: null,
    lastDurationMs: 0,
    lastAudioPath: null,
    lastTranscriptPath: null,
    statusText: "Recording...",
    errorText: "",
  });

  await setActionState("REC", "#bb4d2f", "Recording");
  await showBrowserToast(
    state.targetTabId,
    "Recording started",
    "Tab audio recording has started.",
  );
}

async function handleRecordingComplete(message) {
  const recorderState = await getRecorderState();
  const transcriptionSettings = await getTranscriptionSettings();
  const translationSettings = await getTranslationSettings();
  const ankiSettings = await getAnkiSettings();
  const outputDirectory = await getOutputDirectory();
  const durationMs = message.durationMs || 0;
  const primaryBlob = await getRecordingBlob(message.blobId);

  if (!primaryBlob) {
    throw new Error("Finished recording data could not be loaded.");
  }

  const requestedName = await requestRecordingName(recorderState.targetTabId);
  const relativeAudioFilename = await getNextFilename(
    message.extension,
    requestedName,
  );
  const primaryDownload = await downloadBlobAndWait(
    primaryBlob,
    relativeAudioFilename,
  );

  await deleteRecordingBlob(message.blobId);

  let audioPath = primaryDownload.filename;
  let saveLocationError = "";
  const configError = getTranscriptionConfigurationError(transcriptionSettings);
  const shouldTranscribe = message.transcriptionRequested && !configError;
  let temporaryDownload = null;

  try {
    if (outputDirectory) {
      try {
        audioPath = await requestNativeMoveFile({
          sourcePath: primaryDownload.filename,
          targetDirectory: outputDirectory,
          targetFilename: getFilenameFromPath(primaryDownload.filename),
        });
      } catch (error) {
        saveLocationError = error.message || "The selected save folder could not be used.";
      }
    }

    const transcriptPath = `${stripFileExtension(audioPath)}.txt`;

    if (shouldTranscribe) {
      let sourceAudioPath = audioPath;

      if (message.transcriptionBlobId) {
        const transcriptionBlob = await getRecordingBlob(
          message.transcriptionBlobId,
        );
        if (!transcriptionBlob) {
          throw new Error("Temporary WAV source could not be prepared.");
        }

        const temporaryFilename = buildTemporaryWavFilename(
          relativeAudioFilename,
        );

        temporaryDownload = await downloadBlobAndWait(
          transcriptionBlob,
          temporaryFilename,
        );
        sourceAudioPath = temporaryDownload.filename;
      }

      await setRecorderState({
        isRecording: false,
        isProcessing: true,
        startedAt: null,
        stoppedAt: Date.now(),
        lastDurationMs: durationMs,
        lastAudioPath: audioPath,
        lastTranscriptPath: null,
        statusText: "Saved audio. Transcribing...",
        errorText: "",
      });

      await setActionState("TXT", "#8c5608", "Transcribing");
      await showBrowserToast(
        recorderState.targetTabId,
        "Recording saved",
        "Audio saved locally. Starting transcription...",
      );

      const transcriptionResult = await requestNativeTranscription({
        whisperCliPath: transcriptionSettings.whisperCliPath,
        whisperModelPath: transcriptionSettings.whisperModelPath,
        audioPath: sourceAudioPath,
        transcriptPath,
        language: transcriptionSettings.language,
        recordingName: getFileStem(audioPath),
        ankiDeckName: transcriptionSettings.ankiDeckName,
        ankiSettings,
        ankiEnabled: !translationSettings.enabled,
      });

      const finalTranscriptPath = transcriptionResult.transcriptPath || transcriptPath;
      const transcriptText = String(transcriptionResult.transcriptText || "").trim();
      let translatedText = "";
      let translationError = "";
      let finalAnkiResult = transcriptionResult;
      let completionTitle = "Transcript ready";
      let completionMessage = `Saved to ${finalTranscriptPath}`;
      let statusText = `Transcript saved to ${finalTranscriptPath}`;

      const translationProviderLabel = getTranslationProvider(
        translationSettings.provider,
      ).label;

      if (translationSettings.enabled) {
        await setRecorderState({
          isRecording: false,
          isProcessing: true,
          startedAt: null,
          stoppedAt: Date.now(),
          lastDurationMs: durationMs,
          lastAudioPath: audioPath,
          lastTranscriptPath: finalTranscriptPath,
          statusText: `Transcript ready. Waiting for ${translationProviderLabel}...`,
          errorText: "",
        });

        const translationResult = await TranslationService.capture(
          translationSettings.provider,
          transcriptText,
          {
            sourceLang: transcriptionSettings.language,
            targetLang: translationSettings.targetLanguage,
          },
        );
        translatedText = translationResult.translatedText;
        translationError = translationResult.errorText;
      }

      finalAnkiResult = await requestNativeQueueAnkiCard({
        audioPath,
        transcriptPath: finalTranscriptPath,
        transcriptText,
        translatedText,
        recordingName: getFileStem(audioPath),
        ankiDeckName: transcriptionSettings.ankiDeckName,
        ankiSettings,
      });

      await updateQueueStateFromTranscriptionResult(finalAnkiResult);

      const ankiStatus = finalAnkiResult.anki?.status || "skipped";
      const ankiMessage = finalAnkiResult.anki?.message || "";
      const translationCaptured = Boolean(translatedText);
      const translationSuffix = buildTranslationStatusSuffix({
        enabled: translationSettings.enabled,
        providerLabel: translationProviderLabel,
        translatedText,
        translationError,
      });

      if (ankiStatus === "queued") {
        const pendingCount = Number(finalAnkiResult.pendingCount || 0);
        completionTitle = "Card queued for Anki";
        completionMessage =
          pendingCount > 0
            ? `${pendingCount} queued card${pendingCount === 1 ? "" : "s"} waiting for manual push.`
            : "Card queued for manual push.";
        statusText = `Transcript saved to ${finalTranscriptPath}. Card queued for manual push.${translationSuffix}`;
      } else if (ankiStatus === "error") {
        completionTitle = "Anki queue failed";
        completionMessage = ankiMessage || "Transcript saved, but the card could not be queued.";
        statusText = `Transcript saved to ${finalTranscriptPath}. ${completionMessage}${translationSuffix}`;
      } else {
        statusText = `Transcript saved to ${finalTranscriptPath}.${translationSuffix}`;
      }

      if (translationSettings.enabled && translationError) {
        completionMessage = `${completionMessage} ${translationProviderLabel} could not be read, so the transcript-only note was used.`;
      } else if (translationCaptured) {
        completionMessage = `${completionMessage} ${translationProviderLabel} output was captured.`;
      }

      if (saveLocationError) {
        completionMessage = `${completionMessage} Saved audio in the fallback Downloads location because the selected folder could not be used.`;
        statusText = `${statusText} Saved audio in the fallback Downloads location because the selected folder could not be used: ${saveLocationError}`;
      }

      await cleanupTemporaryDownload(temporaryDownload?.id);

      if (message.transcriptionBlobId) {
        await deleteRecordingBlob(message.transcriptionBlobId);
      }

      await setRecorderState({
        isRecording: false,
        isProcessing: false,
        startedAt: null,
        stoppedAt: Date.now(),
        targetTabId: null,
        lastDurationMs: 0,
        lastAudioPath: audioPath,
        lastTranscriptPath: finalTranscriptPath,
        statusText,
        errorText: "",
      });

      await setActionState("", "#22694f", "Tab Audio Recorder");
      await showBrowserToast(
        recorderState.targetTabId,
        completionTitle,
        completionMessage,
      );
      return;
    }

    if (message.transcriptionBlobId) {
      await deleteRecordingBlob(message.transcriptionBlobId);
    }

    const statusText =
      message.transcriptionRequested && configError
        ? `Saved audio. ${configError}`
        : saveLocationError
          ? `Saved to ${audioPath}. The selected save folder could not be used: ${saveLocationError}`
          : `Saved to ${audioPath}`;

    await setRecorderState({
      isRecording: false,
      isProcessing: false,
      startedAt: null,
      stoppedAt: Date.now(),
      targetTabId: null,
      lastDurationMs: 0,
      lastAudioPath: audioPath,
      lastTranscriptPath: null,
      statusText,
      errorText: "",
    });

    await setActionState("", "#bb4d2f", "Tab Audio Recorder");
    await showBrowserToast(
      recorderState.targetTabId,
      "Recording finished",
      statusText,
    );
  } catch (error) {
    await cleanupTemporaryDownload(temporaryDownload?.id);

    if (message.transcriptionBlobId) {
      await deleteRecordingBlob(message.transcriptionBlobId);
    }

    await setRecorderState({
      isRecording: false,
      isProcessing: false,
      startedAt: null,
      stoppedAt: Date.now(),
      targetTabId: null,
      lastDurationMs: 0,
      lastAudioPath: audioPath,
      lastTranscriptPath: null,
      statusText: saveLocationError
        ? `Saved to ${audioPath}. The selected save folder could not be used: ${saveLocationError}`
        : `Saved to ${audioPath}`,
      errorText: `Audio saved, but transcription failed: ${error.message || "Unknown transcription error."}`,
    });

    await setActionState("", "#8f261f", "Tab Audio Recorder");
    await showBrowserToast(
      recorderState.targetTabId,
      "Transcription failed",
      error.message || "The audio was saved, but transcription did not finish.",
    );
  } finally {
    return;
  }
}

async function handleRecordingError(error) {
  const message = error?.message || "Recording failed.";
  const recorderState = await getRecorderState();

  await setRecorderState({
    isRecording: false,
    isProcessing: false,
    startedAt: null,
    stoppedAt: Date.now(),
    targetTabId: null,
    lastDurationMs: 0,
    statusText: "Recording failed",
    errorText: message,
  });

  await setActionState("", "#8f261f", "Tab Audio Recorder");
  await showBrowserToast(
    recorderState.targetTabId,
    "Recording failed",
    message,
  );
  await closeOffscreenDocument();
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (!offscreenCreationPromise) {
    offscreenCreationPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["USER_MEDIA"],
        justification:
          "Record audio from the active tab while the popup is closed.",
      })
      .finally(() => {
        offscreenCreationPromise = null;
      });
  }

  await offscreenCreationPromise;
  await waitForOffscreenReady();
}

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  return tabs[0]?.id || null;
}

async function clearStaleProcessingState() {
  const recorderState = await getRecorderState();

  if (!recorderState.isProcessing || recorderState.isRecording) {
    return;
  }

  await setRecorderState({
    isProcessing: false,
    lastDurationMs: 0,
    statusText:
      recorderState.lastTranscriptPath || recorderState.lastAudioPath
        ? recorderState.statusText
        : "Idle",
    errorText:
      recorderState.errorText ||
      "The previous transcription did not finish. Please try again.",
  });

  await setActionState("", "#8f261f", "Tab Audio Recorder");
}

async function sendOffscreenMessage(message) {
  await ensureOffscreenDocument();

  try {
    return await chrome.runtime.sendMessage({
      target: "offscreen",
      ...message,
    });
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }

    await waitForOffscreenReady();

    return chrome.runtime.sendMessage({
      target: "offscreen",
      ...message,
    });
  }
}

async function waitForOffscreenReady() {
  const timeoutMs = 3000;
  const pollMs = 100;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "ping",
      });

      if (response?.ok) {
        return;
      }
    } catch (error) {
      lastError = error;

      if (!isMissingReceiverError(error)) {
        throw error;
      }
    }

    await sleep(pollMs);
  }

  throw (
    lastError || new Error("Offscreen recorder did not become ready in time.")
  );
}

async function downloadBlobAndWait(blob, relativeFilename) {
  const dataUrl = await blobToDataUrl(blob);
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: relativeFilename,
    saveAs: false,
    conflictAction: "uniquify",
  });

  return waitForDownloadCompletion(downloadId);
}

async function waitForDownloadCompletion(downloadId) {
  const existingItem = await getDownloadItem(downloadId);
  if (existingItem?.state === "complete") {
    return existingItem;
  }

  if (existingItem?.state === "interrupted") {
    throw new Error(existingItem.error || "Download was interrupted.");
  }

  return new Promise((resolve, reject) => {
    const listener = async (delta) => {
      if (delta.id !== downloadId) {
        return;
      }

      if (delta.state?.current === "complete") {
        chrome.downloads.onChanged.removeListener(listener);
        try {
          resolve(await getDownloadItem(downloadId));
        } catch (error) {
          reject(error);
        }
      }

      if (delta.state?.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(delta.error?.current || "Download was interrupted."));
      }
    };

    chrome.downloads.onChanged.addListener(listener);
  });
}

async function getDownloadItem(downloadId) {
  const items = await chrome.downloads.search({ id: downloadId });
  return items[0] || null;
}

function buildAvTestFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${DEFAULT_DOWNLOAD_FOLDER}/av_test_${timestamp}.webm`;
}

async function cleanupTemporaryDownload(downloadId) {
  if (!downloadId) {
    return;
  }

  try {
    await chrome.downloads.removeFile(downloadId);
  } catch (error) {
    console.warn("Could not remove temporary WAV file:", error);
  }

  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch (error) {
    console.warn("Could not clear temporary WAV download entry:", error);
  }
}

async function requestNativeTranscription(options) {
  return requestNativeHostMessage({
    type: "process-recording",
    whisperCliPath: options.whisperCliPath,
    whisperModelPath: options.whisperModelPath,
    audioPath: options.audioPath,
    transcriptPath: options.transcriptPath,
    language: options.language,
    recordingName: options.recordingName,
    anki: buildNativeAnkiConfig(options),
  });
}

async function requestNativeQueueAnkiCard(options) {
  try {
    return await requestNativeHostMessage({
      type: "queue-anki-card",
      audioPath: options.audioPath,
      transcriptPath: options.transcriptPath,
      transcriptText: options.transcriptText,
      translatedText: options.translatedText,
      recordingName: options.recordingName,
      anki: buildNativeAnkiConfig(options),
    });
  } catch (error) {
    const queueState = await syncAnkiQueueState({ suppressErrors: true });
    return {
      anki: {
        status: "error",
        message: error.message || "Anki card queueing failed.",
      },
      pendingCount: queueState.pendingCount || 0,
    };
  }
}

async function requestNativeQueueStatus() {
  return requestNativeHostMessage({
    type: "queue-status",
  });
}

async function requestNativeQueueFlush() {
  return requestNativeHostMessage({
    type: "flush-anki-queue",
  });
}

async function requestNativeQueueItems() {
  return requestNativeHostMessage({
    type: "queue-items",
  });
}

async function requestNativeDropQueueItem(jobId) {
  return requestNativeHostMessage({
    type: "drop-queue-item",
    jobId,
  });
}

async function requestNativeMoveFile(options) {
  const result = await requestNativeHostMessage({
    type: "move-file",
    sourcePath: options.sourcePath,
    targetDirectory: options.targetDirectory,
    targetFilename: options.targetFilename,
  });

  return String(result.destinationPath || "").trim();
}

async function requestNativePathSelection(options = {}) {
  const result = await requestNativeHostMessage({
    type: "pick-path",
    kind: options.kind,
    currentPath: options.currentPath,
  });

  return String(result.selectedPath || "").trim();
}

function buildNativeAnkiConfig(options = {}) {
  const ankiSettings = options.ankiSettings || DEFAULT_ANKI_SETTINGS;

  return {
    enabled: options.ankiEnabled !== false,
    connectUrl: ANKI_CONNECT_URL,
    deckName: String(options.ankiDeckName || "").trim(),
    noteType: ankiSettings.noteType,
    fields: ankiSettings.fields,
  };
}

async function requestNativeHostMessage(payload) {
  let response = null;

  try {
    response = await chrome.runtime.sendNativeMessage(
      NATIVE_TRANSCRIBER_HOST,
      payload,
    );
  } catch (error) {
    const message = String(error?.message || error || "");

    if (
      message.includes("native messaging host not found") ||
      message.includes("Specified native messaging host not found")
    ) {
      throw new Error(
        "Native host is not installed. Run install-native-host.ps1 with your extension ID, then reload the extension.",
      );
    }

    if (
      message.includes("forbidden") ||
      message.includes("Access to the specified native messaging host is forbidden")
    ) {
      throw new Error(
        "Native host access is not allowed for this extension ID. Re-run install-native-host.ps1 with the current extension ID.",
      );
    }

    throw new Error(
      message || "Native transcription host could not be reached.",
    );
  }

  if (!response?.ok) {
    throw new Error(
      response?.error || "The native transcription host rejected the request.",
    );
  }

  return response;
}

async function syncAnkiQueueState(options = {}) {
  const currentState = await getAnkiQueueState();

  try {
    const result = await requestNativeQueueStatus();
    return setAnkiQueueState({
      pendingCount: Number(result.pendingCount || 0),
      isSyncing: false,
      statusText: buildQueueCountText(result.pendingCount || 0),
      errorText: "",
      lastUpdatedAt: Date.now(),
    });
  } catch (error) {
    if (options.suppressErrors) {
      return currentState;
    }

    return setAnkiQueueState({
      isSyncing: false,
      statusText: currentState.statusText || buildQueueCountText(currentState.pendingCount || 0),
      errorText: error.message || "Queue status could not be loaded.",
      lastUpdatedAt: Date.now(),
    });
  }
}

async function updateQueueStateFromTranscriptionResult(result) {
  const pendingCount = Number(result?.pendingCount || 0);
  let statusText = buildQueueCountText(pendingCount);
  let errorText = "";

  if (result?.anki?.status === "queued") {
    statusText =
      pendingCount > 0
        ? `${pendingCount} queued card${pendingCount === 1 ? "" : "s"} waiting for manual push.`
        : "Card queued for manual push.";
  }

  if (result?.anki?.status === "error" && result?.anki?.message) {
    errorText = result.anki.message;
  }

  return setAnkiQueueState({
    pendingCount,
    isSyncing: false,
    statusText,
    errorText,
    lastUpdatedAt: Date.now(),
  });
}

async function flushQueuedAnkiCards() {
  const currentState = await setAnkiQueueState({
    isSyncing: true,
    errorText: "",
    statusText: "Pushing queued cards...",
    lastUpdatedAt: Date.now(),
  });

  try {
    const result = await requestNativeQueueFlush();
    const pendingCount = Number(result.pendingCount || 0);
    const createdCount = Number(result.createdCount || 0);
    const failedCount = Number(result.failedCount || 0);
    let queueState = null;
    let response = { ok: true };

    if (result.status === "offline") {
      queueState = await setAnkiQueueState({
        pendingCount,
        isSyncing: false,
        statusText: buildQueueCountText(pendingCount),
        errorText: "Anki is offline. The queued cards were kept for later.",
        lastUpdatedAt: Date.now(),
      });
      response = {
        ok: false,
        error: queueState.errorText,
      };
    } else if (result.status === "created") {
      queueState = await setAnkiQueueState({
        pendingCount,
        isSyncing: false,
        statusText:
          createdCount > 0
            ? `${createdCount} queued card${createdCount === 1 ? "" : "s"} pushed to Anki.`
            : buildQueueCountText(pendingCount),
        errorText: "",
        lastUpdatedAt: Date.now(),
      });
    } else if (result.status === "partial" || result.status === "error") {
      queueState = await setAnkiQueueState({
        pendingCount,
        isSyncing: false,
        statusText:
          createdCount > 0
            ? `${createdCount} queued card${createdCount === 1 ? "" : "s"} pushed to Anki.`
            : buildQueueCountText(pendingCount),
        errorText:
          failedCount > 0
            ? `${failedCount} queued card${failedCount === 1 ? "" : "s"} could not be pushed yet.`
            : "Some queued cards could not be pushed yet.",
        lastUpdatedAt: Date.now(),
      });
      response = {
        ok: false,
        error: queueState.errorText,
      };
    } else {
      queueState = await setAnkiQueueState({
        pendingCount,
        isSyncing: false,
        statusText: buildQueueCountText(pendingCount),
        errorText: "",
        lastUpdatedAt: Date.now(),
      });
    }

    return {
      ...response,
      queueState,
    };
  } catch (error) {
    const queueState = await setAnkiQueueState({
      pendingCount: currentState.pendingCount || 0,
      isSyncing: false,
      statusText: buildQueueCountText(currentState.pendingCount || 0),
      errorText: error.message || "Queued cards could not be pushed.",
      lastUpdatedAt: Date.now(),
    });

    return {
      ok: false,
      error: queueState.errorText,
      queueState,
    };
  }
}

function buildQueueCountText(pendingCount) {
  const count = Number(pendingCount || 0);

  if (count <= 0) {
    return "Queue empty.";
  }

  return `${count} queued card${count === 1 ? "" : "s"} waiting for manual push.`;
}

function isMissingReceiverError(error) {
  return String(error?.message || error || "").includes(
    "Receiving end does not exist",
  );
}

function buildTranslationStatusSuffix(options = {}) {
  if (!options.enabled) {
    return "";
  }

  const providerLabel = options.providerLabel || "Translation";

  if (options.translatedText) {
    return ` ${providerLabel} output captured.`;
  }

  if (options.translationError) {
    return ` ${providerLabel} fallback used: ${options.translationError}`;
  }

  return "";
}

async function requestRecordingName(tabId) {
  if (!tabId) {
    return "";
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const value = window.prompt(
          "Name this recording. Leave blank to save with the next number.",
          "",
        );

        return value == null ? "" : value;
      },
    });

    return sanitizeRecordingName(results?.[0]?.result || "");
  } catch (error) {
    console.warn("Could not prompt for a recording name:", error);
    return "";
  }
}

// --- Video-detection spike (throwaway) ------------------------------------
// De-risks the browser video-mining direction: can we find the active <video>
// and read a live-advancing currentTime inside whatever (cross-origin) frame it
// lives in, WITHOUT DevTools (which anti-debug sites trap) and without new
// permissions? Injects into every frame of the active tab under the activeTab
// grant and reports back to the popup. Delete this block + its handler + the
// popup button to remove.
async function runVideoDetection(tabId) {
  if (!tabId) {
    return { ok: false, error: "No active tab to inspect." };
  }

  try {
    // One injectionResult per frame the extension could reach. A cross-origin
    // player frame that is MISSING here (vs. present-but-empty) means activeTab
    // did not reach it — the signal that the real feature needs broad host
    // permissions like asbplayer.
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: detectVideosInFrame,
    });

    const frames = (results || []).map((entry) => ({
      frameId: entry.frameId,
      ...(entry.result || {
        error: "Injection produced no result for this frame.",
      }),
    }));

    return { ok: true, frames };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "Video detection failed.",
    };
  }
}

// Runs INSIDE each frame (serialized via toString → must close over nothing:
// no imports, no background-scope references, only its own inner helpers and
// the frame's globals). Isolated world: shares the DOM to read currentTime but
// stays invisible to the page's own scripts.
async function detectVideosInFrame() {
  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Enumerate media across the light DOM and any OPEN shadow roots. Closed
    // shadow roots are unreachable here — a video hidden in one reports as
    // "not found", which is itself a valid finding.
    const media = [];
    const seen = new Set();
    const visit = (root) => {
      let direct = [];
      try {
        direct = root.querySelectorAll("video, audio");
      } catch (_) {
        direct = [];
      }
      for (const el of direct) {
        if (!seen.has(el)) {
          seen.add(el);
          media.push(el);
        }
      }
      let all = [];
      try {
        all = root.querySelectorAll("*");
      } catch (_) {
        all = [];
      }
      for (const el of all) {
        if (el.shadowRoot) {
          visit(el.shadowRoot);
        }
      }
    };
    visit(document);

    const videos = media.filter((el) => el.tagName === "VIDEO");

    // The "active" video: prefer one that is playing and decodable, else the
    // largest by visible area (skips 0×0 hidden preload elements).
    const area = (el) => {
      const rect = el.getBoundingClientRect();
      return Math.max(0, rect.width) * Math.max(0, rect.height);
    };
    let active = videos.find((v) => !v.paused && v.readyState >= 2) || null;
    if (!active && videos.length) {
      active = videos.slice().sort((a, b) => area(b) - area(a))[0];
    }

    let activeInfo = null;
    let canReadCurrentTime = false;
    if (active) {
      const rect = active.getBoundingClientRect();
      let first = null;
      let second = null;
      try {
        first = active.currentTime;
        canReadCurrentTime = typeof first === "number";
      } catch (_) {
        canReadCurrentTime = false;
      }
      // Sample again to prove the clock advances (i.e. it is really playing).
      await wait(500);
      try {
        second = active.currentTime;
      } catch (_) {
        second = null;
      }
      const advanced =
        typeof first === "number" && typeof second === "number"
          ? second > first
          : null;
      const src = active.currentSrc || active.src || "";
      activeInfo = {
        currentTime: first,
        currentTimeAfter: second,
        advanced,
        duration: active.duration,
        paused: active.paused,
        readyState: active.readyState,
        videoWidth: active.videoWidth,
        videoHeight: active.videoHeight,
        currentSrc: src.slice(0, 120),
        rectW: Math.round(rect.width),
        rectH: Math.round(rect.height),
      };
    }

    return {
      frameUrl: location.href,
      isTop: window.top === window,
      origin: location.origin,
      videoCount: videos.length,
      audioCount: media.length - videos.length,
      canReadCurrentTime,
      active: activeInfo,
    };
  } catch (error) {
    let frameUrl = "(unknown)";
    try {
      frameUrl = location.href;
    } catch (_) {
      frameUrl = "(unknown)";
    }
    return {
      error: String(error && error.message ? error.message : error),
      frameUrl,
    };
  }
}
// --- end video-detection spike --------------------------------------------

// --- Jimaku subtitle fetch --------------------------------------------------
// The Jimaku API (https://jimaku.cc/api) is called from the service worker so the
// granted <all_urls> host access bypasses CORS. The user's key lives in
// subtitleSettings. Personal-use only; the 25 req/60s limit is surfaced as-is.
const JIMAKU_API_BASE = "https://jimaku.cc/api";

async function jimakuApiRequest(path) {
  const settings = await getSubtitleSettings();
  const key = settings.jimakuApiKey;
  if (!key) {
    return {
      ok: false,
      error: "Add your Jimaku API key in the extension popup (jimaku.cc/account).",
    };
  }

  let response;
  try {
    response = await fetch(`${JIMAKU_API_BASE}${path}`, {
      headers: { Authorization: key },
    });
  } catch (_) {
    return { ok: false, error: "Could not reach Jimaku." };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "Jimaku rejected the API key." };
  }
  if (response.status === 429) {
    return {
      ok: false,
      error: "Jimaku rate limit reached — wait a minute and retry.",
    };
  }
  if (!response.ok) {
    return { ok: false, error: `Jimaku request failed (${response.status}).` };
  }

  const data = await response.json().catch(() => null);
  return { ok: true, data };
}

async function jimakuSearch(message) {
  const params = new URLSearchParams();
  if (message.anilistId) {
    params.set("anilist_id", String(message.anilistId));
  } else if (message.query && String(message.query).trim()) {
    params.set("query", String(message.query).trim());
  } else {
    return { ok: false, error: "Enter an anime name to search." };
  }

  const result = await jimakuApiRequest(`/entries/search?${params.toString()}`);
  if (!result.ok) {
    return result;
  }
  return { ok: true, entries: Array.isArray(result.data) ? result.data : [] };
}

async function jimakuFiles(message) {
  if (message.entryId == null) {
    return { ok: false, error: "Missing entry id." };
  }
  const params = new URLSearchParams();
  if (message.episode) {
    params.set("episode", String(message.episode));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await jimakuApiRequest(
    `/entries/${encodeURIComponent(message.entryId)}/files${suffix}`,
  );
  if (!result.ok) {
    return result;
  }
  return { ok: true, files: Array.isArray(result.data) ? result.data : [] };
}

async function jimakuDownload(message) {
  const url = String(message.url || "");
  if (!/^https:\/\/jimaku\.cc\//i.test(url)) {
    return { ok: false, error: "Invalid Jimaku download URL." };
  }
  const settings = await getSubtitleSettings();
  try {
    const response = await fetch(url, {
      headers: settings.jimakuApiKey
        ? { Authorization: settings.jimakuApiKey }
        : {},
    });
    if (!response.ok) {
      return { ok: false, error: `Download failed (${response.status}).` };
    }
    const content = await response.text();
    return { ok: true, content };
  } catch (_) {
    return { ok: false, error: "Could not download the subtitle file." };
  }
}
// --- end Jimaku subtitle fetch ----------------------------------------------

// Runs an analysis-only tab-audio capture for automatic subtitle sync. The offscreen
// doc returns a WAV clip which handleAutoSyncClip transcribes; the tab's overlay then
// matches the transcript to the loaded subtitles. Must be called from an
// activeTab-granting context (popup click or a command) — tabCapture rejects
// otherwise. Reuses the recorder's offscreen plumbing.
async function startAutoSyncForTab(tabId) {
  if (!tabId) {
    return;
  }
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });
    // The offscreen doc acks immediately and later pushes autosync-started /
    // autosync-clip (both carrying tabId), so the SW needn't stay alive for the
    // whole capture. ~12s is plenty: text matching only needs a couple of
    // distinctive lines, and a shorter clip transcribes faster.
    await sendOffscreenMessage({
      type: "analyze-audio",
      streamId,
      tabId,
      durationMs: 12000,
    });
  } catch (error) {
    chrome.tabs
      .sendMessage(tabId, {
        type: "autosync-error",
        error: error?.message || "Could not capture the tab audio.",
      })
      .catch(() => {});
  }
}

// Transcribes an auto-sync clip through the native host and pushes the resulting
// segments to the tab's overlay. Runs detached from the SW message handler so a
// long whisper run can't block it; the tabId routes the result back even if the
// worker was recycled meanwhile.
async function handleAutoSyncClip(message) {
  const tabId = message.tabId;
  if (tabId == null) {
    return;
  }
  try {
    const transcriptionSettings = await getTranscriptionSettings();
    if (
      !transcriptionSettings.whisperCliPath ||
      !transcriptionSettings.whisperModelPath
    ) {
      throw new Error(
        "Set the Whisper path and model in the desktop app first.",
      );
    }

    const response = await requestNativeHostMessage({
      type: "transcribe-clip",
      wav: message.wavBase64,
      // Auto-sync targets Japanese immersion (Jimaku subs + Japanese audio), so
      // pin the language rather than risk auto-detect on a short clip.
      language: "ja",
      whisperCliPath: transcriptionSettings.whisperCliPath,
      whisperModelPath: transcriptionSettings.whisperModelPath,
    });

    const segments = Array.isArray(response?.segments) ? response.segments : [];
    chrome.tabs
      .sendMessage(tabId, { type: "autosync-run", segments })
      .catch(() => {});
  } catch (error) {
    chrome.tabs
      .sendMessage(tabId, {
        type: "autosync-error",
        error: error?.message || "Could not transcribe the audio.",
      })
      .catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function setActionState(text, color, title) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}

async function showBrowserToast(tabId, title, message) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (toastTitle, toastMessage) => {
        const toastId = "__tab_audio_recorder_toast__";
        const existingToast = document.getElementById(toastId);

        if (existingToast) {
          existingToast.remove();
        }

        const toast = document.createElement("div");
        const titleNode = document.createElement("div");
        const messageNode = document.createElement("div");

        toast.id = toastId;
        toast.style.position = "fixed";
        toast.style.top = "20px";
        toast.style.right = "20px";
        toast.style.zIndex = "2147483647";
        toast.style.maxWidth = "320px";
        toast.style.padding = "14px 16px";
        toast.style.borderRadius = "16px";
        toast.style.background = "rgba(34, 24, 18, 0.96)";
        toast.style.color = "#fff7f2";
        toast.style.boxShadow = "0 18px 40px rgba(0, 0, 0, 0.28)";
        toast.style.fontFamily = "Trebuchet MS, Segoe UI, sans-serif";
        toast.style.lineHeight = "1.45";
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-8px)";
        toast.style.transition = "opacity 160ms ease, transform 160ms ease";

        titleNode.textContent = toastTitle;
        titleNode.style.fontSize = "14px";
        titleNode.style.fontWeight = "700";
        titleNode.style.marginBottom = "4px";

        messageNode.textContent = toastMessage;
        messageNode.style.fontSize = "12px";
        messageNode.style.color = "rgba(255, 244, 237, 0.86)";

        toast.appendChild(titleNode);
        toast.appendChild(messageNode);
        (document.body || document.documentElement).appendChild(toast);

        requestAnimationFrame(() => {
          toast.style.opacity = "1";
          toast.style.transform = "translateY(0)";
        });

        window.setTimeout(() => {
          toast.style.opacity = "0";
          toast.style.transform = "translateY(-8px)";
          window.setTimeout(() => {
            toast.remove();
          }, 180);
        }, 2600);
      },
      args: [title, message],
    });
  } catch (error) {
    console.warn("Could not show in-browser toast:", error);
  }
}
