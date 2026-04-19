importScripts("utils.js");

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const NATIVE_TRANSCRIBER_HOST = "com.audio_recorder.whisper_host";
const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
const ANKI_DECK_NAME = "Audio Immersion";
const ANKI_MODEL_NAME = "Basic";
const ANKI_FRONT_FIELD = "Front";
const ANKI_BACK_FIELD = "Back";

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

chrome.commands.onCommand.addListener(async (command) => {
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
    message?.action === "GET_QUEUE_STATUS"
  ) {
    handleControlMessage(message)
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

async function handleControlMessage(message) {
  if (!message) {
    return { ok: false, error: "Empty message." };
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

  if (message.action === "GET_QUEUE_STATUS") {
    const queueState = await syncAnkiQueueState();
    return { ok: true, queueState };
  }

  if (message.action === "FLUSH_QUEUE") {
    return flushQueuedAnkiCards();
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
  await clearStaleProcessingState();
  await syncAnkiQueueState({ suppressErrors: true });
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

  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId,
  });

  await sendOffscreenMessage({
    type: "start-recording",
    streamId,
    format: await getFormat(),
    transcriptionEnabled: transcriptionSettings.enabled,
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

  await sendOffscreenMessage({
    type: "stop-recording",
  });
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

  const audioPath = primaryDownload.filename;
  const transcriptPath = `${stripFileExtension(audioPath)}.txt`;
  const configError = getTranscriptionConfigurationError(transcriptionSettings);
  const shouldTranscribe = message.transcriptionRequested && !configError;
  let temporaryDownload = null;

  try {
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
      });
      await updateQueueStateFromTranscriptionResult(transcriptionResult);

      const finalTranscriptPath = transcriptionResult.transcriptPath || transcriptPath;
      const ankiStatus = transcriptionResult.anki?.status || "skipped";
      const ankiMessage = transcriptionResult.anki?.message || "";
      let completionTitle = "Transcript ready";
      let completionMessage = `Saved to ${finalTranscriptPath}`;
      let statusText = `Transcript saved to ${finalTranscriptPath}`;

      if (ankiStatus === "created") {
        completionTitle = "New card created successfully";
        completionMessage = `Added to ${ANKI_DECK_NAME}`;
        statusText = `Transcript saved to ${finalTranscriptPath}. New card created successfully.`;
      } else if (ankiStatus === "queued") {
        const pendingCount = Number(transcriptionResult.pendingCount || 0);
        completionTitle = "Anki offline, card queued";
        completionMessage =
          pendingCount > 0
            ? `${pendingCount} queued card${pendingCount === 1 ? "" : "s"} waiting for Anki.`
            : "Card queued for Anki.";
        statusText = `Transcript saved to ${finalTranscriptPath}. Card queued for Anki.`;
      } else if (ankiStatus === "offline") {
        completionTitle = "Anki offline";
        completionMessage = "Transcript saved locally. Open Anki to add cards.";
        statusText = `Transcript saved to ${finalTranscriptPath}. Anki offline.`;
      } else if (ankiStatus === "error") {
        completionTitle = "Anki card failed";
        completionMessage = ankiMessage || "Transcript saved, but the Anki card was not created.";
        statusText = `Transcript saved to ${finalTranscriptPath}. ${completionMessage}`;
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
        : `Saved to Downloads/${relativeAudioFilename}`;

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
      statusText: `Saved to Downloads/${relativeAudioFilename}`,
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
    anki: buildNativeAnkiConfig(),
  });
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

async function requestNativePathSelection(options = {}) {
  const result = await requestNativeHostMessage({
    type: "pick-path",
    kind: options.kind,
    currentPath: options.currentPath,
  });

  return String(result.selectedPath || "").trim();
}

function buildNativeAnkiConfig() {
  return {
    enabled: true,
    connectUrl: ANKI_CONNECT_URL,
    deckName: ANKI_DECK_NAME,
    modelName: ANKI_MODEL_NAME,
    frontField: ANKI_FRONT_FIELD,
    backField: ANKI_BACK_FIELD,
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
        ? `${pendingCount} queued card${pendingCount === 1 ? "" : "s"} waiting for Anki.`
        : "Card queued for Anki.";
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

  return `${count} queued card${count === 1 ? "" : "s"} waiting for Anki.`;
}

function isMissingReceiverError(error) {
  return String(error?.message || error || "").includes(
    "Receiving end does not exist",
  );
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
