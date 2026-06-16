const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const status = document.getElementById("status");
const timer = document.getElementById("timer");
const statePill = document.getElementById("statePill");
const formatSelect = document.getElementById("format");
const outputDirectoryInput = document.getElementById("outputDirectory");
const browseOutputDirectoryBtn = document.getElementById("browseOutputDirectory");
const pathHint = document.getElementById("pathHint");
const avTestVideoBitrateSelect = document.getElementById("avTestVideoBitrate");
const avTestAudioBitrateSelect = document.getElementById("avTestAudioBitrate");
const startAvTestBtn = document.getElementById("startAvTest");
const avTestStatus = document.getElementById("avTestStatus");
const transcriptionEnabledInput = document.getElementById("transcriptionEnabled");
const whisperCliPathInput = document.getElementById("whisperCliPath");
const whisperModelPathInput = document.getElementById("whisperModelPath");
const browseWhisperCliPathBtn = document.getElementById("browseWhisperCliPath");
const browseWhisperModelPathBtn = document.getElementById("browseWhisperModelPath");
const whisperLanguageInput = document.getElementById("whisperLanguage");
const ankiDeckNameInput = document.getElementById("ankiDeckName");
const translationEnabledInput = document.getElementById("translationEnabled");
const transcriptionFields = document.getElementById("transcriptionFields");
const queueCount = document.getElementById("queueCount");
const queueStatus = document.getElementById("queueStatus");
const pushQueueBtn = document.getElementById("pushQueue");
const queueList = document.getElementById("queueList");

let currentState = DEFAULT_RECORDER_STATE;
let currentTranscriptionSettings = DEFAULT_TRANSCRIPTION_SETTINGS;
let currentTranslationSettings = DEFAULT_TRANSLATION_SETTINGS;
let currentQueueState = DEFAULT_ANKI_QUEUE_STATE;
let currentQueueItems = [];
let currentOutputDirectory = DEFAULT_OUTPUT_DIRECTORY;
let timerInterval = null;
let whisperCliPathPersistTimer = null;
let whisperModelPathPersistTimer = null;
let whisperLanguagePersistTimer = null;
let ankiDeckNamePersistTimer = null;
let outputDirectoryPersistTimer = null;
let avTestRunning = false;

initializePopup().catch((error) => {
  renderStatus("Unable to load popup settings.", "error");
  console.error(error);
});

startBtn.addEventListener("click", async () => {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    const response = await chrome.runtime.sendMessage({
      action: "START",
      tabId: activeTab?.id,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not start recording.");
    }
  } catch (error) {
    renderStatus(error.message || "Could not start recording.", "error");
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "STOP",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not stop recording.");
    }
  } catch (error) {
    renderStatus(error.message || "Could not stop recording.", "error");
  }
});

pushQueueBtn.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "FLUSH_QUEUE",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Queued cards could not be pushed.");
    }
  } catch (error) {
    renderQueueStatus(
      error.message || "Queued cards could not be pushed.",
      "error",
    );
  } finally {
    await refreshQueueItems();
  }
});

queueList.addEventListener("click", async (event) => {
  const dropButton = event.target.closest("[data-queue-drop]");
  if (!dropButton) {
    return;
  }

  dropButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      action: "DROP_QUEUE_ITEM",
      jobId: dropButton.dataset.queueDrop,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The queued card could not be removed.");
    }

    currentQueueItems = Array.isArray(response.items) ? response.items : [];
    renderQueueItems();
  } catch (error) {
    renderQueueStatus(
      error.message || "The queued card could not be removed.",
      "error",
    );
  } finally {
    await refreshQueueItems();
  }
});

formatSelect.addEventListener("change", async () => {
  const nextFormat = await setFormat(formatSelect.value);
  formatSelect.value = nextFormat;
});

browseOutputDirectoryBtn.addEventListener("click", async () => {
  await handleDirectoryBrowse();
});

startAvTestBtn.addEventListener("click", async () => {
  await handleAvCaptureTest();
});

outputDirectoryInput.addEventListener("change", async () => {
  const nextDirectory = await setOutputDirectory(outputDirectoryInput.value);
  currentOutputDirectory = nextDirectory;
  outputDirectoryInput.value = nextDirectory;
  renderOutputDirectory();
});
outputDirectoryInput.addEventListener("input", () => {
  schedulePersistedSetting("outputDirectory", outputDirectoryInput.value);
});

transcriptionEnabledInput.addEventListener("change", async () => {
  await persistTranscriptionSettings({
    enabled: transcriptionEnabledInput.checked,
  });
});

whisperCliPathInput.addEventListener("change", async () => {
  await persistTranscriptionSettings({
    whisperCliPath: whisperCliPathInput.value,
  });
});
whisperCliPathInput.addEventListener("input", () => {
  schedulePersistedSetting("whisperCliPath", whisperCliPathInput.value);
});

whisperModelPathInput.addEventListener("change", async () => {
  await persistTranscriptionSettings({
    whisperModelPath: whisperModelPathInput.value,
  });
});
whisperModelPathInput.addEventListener("input", () => {
  schedulePersistedSetting("whisperModelPath", whisperModelPathInput.value);
});

browseWhisperCliPathBtn.addEventListener("click", async () => {
  await handlePathBrowse("cli", whisperCliPathInput, browseWhisperCliPathBtn);
});

browseWhisperModelPathBtn.addEventListener("click", async () => {
  await handlePathBrowse(
    "model",
    whisperModelPathInput,
    browseWhisperModelPathBtn
  );
});

whisperLanguageInput.addEventListener("change", async () => {
  await persistTranscriptionSettings({
    language: whisperLanguageInput.value,
  });
});
whisperLanguageInput.addEventListener("input", () => {
  schedulePersistedSetting("language", whisperLanguageInput.value);
});

ankiDeckNameInput.addEventListener("change", async () => {
  await persistTranscriptionSettings({
    ankiDeckName: ankiDeckNameInput.value,
  });
});
ankiDeckNameInput.addEventListener("input", () => {
  schedulePersistedSetting("ankiDeckName", ankiDeckNameInput.value);
});

translationEnabledInput.addEventListener("change", async () => {
  if (translationEnabledInput.checked) {
    const granted = await requestGoogleTranslatePermission();

    if (!granted) {
      translationEnabledInput.checked = false;
      renderStatus(
        "Google Translate permission was not granted. Translation stayed off.",
        "error",
      );
      await persistTranslationSettings({ enabled: false });
      return;
    }
  }

  await persistTranslationSettings({
    enabled: translationEnabledInput.checked,
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.format) {
    formatSelect.value = changes.format.newValue || DEFAULT_FORMAT;
  }

  if (changes.outputDirectory) {
    currentOutputDirectory = sanitizeLocalPath(changes.outputDirectory.newValue);
    renderOutputDirectory();
  }

  if (changes.transcriptionSettings) {
    currentTranscriptionSettings = normalizeTranscriptionSettings(
      changes.transcriptionSettings.newValue
    );
    renderTranscriptionSettings();
  }

  if (changes.translationSettings) {
    currentTranslationSettings = normalizeTranslationSettings(
      changes.translationSettings.newValue
    );
    renderTranslationSettings();
  }

  if (changes.ankiQueueState) {
    currentQueueState = {
      ...DEFAULT_ANKI_QUEUE_STATE,
      ...(changes.ankiQueueState.newValue || {}),
    };
    renderQueueState();
    refreshQueueItems().catch(() => {});
  }

  if (changes.recorderState) {
    currentState = {
      ...DEFAULT_RECORDER_STATE,
      ...(changes.recorderState.newValue || {}),
    };
    renderRecorderState();
  }
});

async function initializePopup() {
  await ensureSettings();

  const [
    format,
    outputDirectory,
    recorderState,
    transcriptionSettings,
    translationSettings,
    ankiQueueState,
  ] =
    await Promise.all([
      getFormat(),
      getOutputDirectory(),
      getRecorderState(),
      getTranscriptionSettings(),
      getTranslationSettings(),
      getAnkiQueueState(),
    ]);

  formatSelect.value = format;
  currentOutputDirectory = outputDirectory;
  renderOutputDirectory();
  currentState = recorderState;
  currentTranscriptionSettings = transcriptionSettings;
  currentTranslationSettings = translationSettings;
  currentQueueState = ankiQueueState;

  renderTranscriptionSettings();
  renderTranslationSettings();
  renderQueueState();
  renderQueueItems();
  renderRecorderState();
  await refreshQueueState();
  await refreshQueueItems();
}

async function persistTranscriptionSettings(partialSettings) {
  currentTranscriptionSettings = await updateTranscriptionSettings(partialSettings);
  renderTranscriptionSettings();
}

async function persistTranslationSettings(partialSettings) {
  currentTranslationSettings = await updateTranslationSettings(partialSettings);
  renderTranslationSettings();
}

async function handleDirectoryBrowse() {
  const originalLabel = browseOutputDirectoryBtn.textContent;

  browseOutputDirectoryBtn.disabled = true;
  browseOutputDirectoryBtn.textContent = "Picking...";

  try {
    const response = await chrome.runtime.sendMessage({
      action: "BROWSE_PATH",
      pathKind: "output-directory",
      currentPath: outputDirectoryInput.value,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "A folder could not be selected.");
    }

    if (response.cancelled || !response.path) {
      return;
    }

    currentOutputDirectory = await setOutputDirectory(response.path);
    renderOutputDirectory();
  } catch (error) {
    renderStatus(error.message || "A folder could not be selected.", "error");
  } finally {
    browseOutputDirectoryBtn.disabled = false;
    browseOutputDirectoryBtn.textContent = originalLabel;
  }
}

async function handlePathBrowse(kind, input, button) {
  const originalLabel = button.textContent;

  button.disabled = true;
  button.textContent = "Picking...";

  try {
    const response = await chrome.runtime.sendMessage({
      action: "BROWSE_PATH",
      pathKind: kind,
      currentPath: input.value,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "A file could not be selected.");
    }

    if (response.cancelled || !response.path) {
      return;
    }

    input.value = response.path;

    await persistTranscriptionSettings({
      [kind === "cli" ? "whisperCliPath" : "whisperModelPath"]: response.path,
    });
  } catch (error) {
    renderStatus(error.message || "A file could not be selected.", "error");
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function handleAvCaptureTest() {
  avTestRunning = true;
  startAvTestBtn.disabled = true;
  startAvTestBtn.textContent = "Recording...";
  renderAvTestStatus("Recording current tab audio and video for 5 seconds.", "");

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    const response = await chrome.runtime.sendMessage({
      action: "START_AV_TEST",
      tabId: activeTab?.id,
      videoBitsPerSecond: Number(avTestVideoBitrateSelect.value),
      audioBitsPerSecond: Number(avTestAudioBitrateSelect.value),
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The A/V capture test failed.");
    }

    renderAvTestStatus(
      `Saved ${response.filename || "A/V test recording"}. Actual bitrate: video ${formatBitrate(response.actualVideoBitsPerSecond)}, audio ${formatBitrate(response.actualAudioBitsPerSecond)}.`,
      "",
    );
  } catch (error) {
    renderAvTestStatus(
      error.message || "The A/V capture test failed.",
      "error",
    );
  } finally {
    avTestRunning = false;
    startAvTestBtn.textContent = "Record current tab 5s";
    renderButtons();
  }
}

function schedulePersistedSetting(key, value) {
  const timerKey = getPersistTimerKey(key);
  const existingTimer = getPersistTimer(timerKey);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const nextTimer = window.setTimeout(async () => {
    setPersistTimer(timerKey, null);
    if (key === "outputDirectory") {
      currentOutputDirectory = await setOutputDirectory(value);
      renderOutputDirectory();
      return;
    }

    await persistTranscriptionSettings({ [key]: value });
  }, 250);

  setPersistTimer(timerKey, nextTimer);
}

function getPersistTimerKey(key) {
  switch (key) {
    case "whisperCliPath":
      return "whisperCliPathPersistTimer";
    case "whisperModelPath":
      return "whisperModelPathPersistTimer";
    case "language":
      return "whisperLanguagePersistTimer";
    case "ankiDeckName":
      return "ankiDeckNamePersistTimer";
    case "outputDirectory":
      return "outputDirectoryPersistTimer";
    default:
      return "";
  }
}

function getPersistTimer(timerKey) {
  switch (timerKey) {
    case "whisperCliPathPersistTimer":
      return whisperCliPathPersistTimer;
    case "whisperModelPathPersistTimer":
      return whisperModelPathPersistTimer;
    case "whisperLanguagePersistTimer":
      return whisperLanguagePersistTimer;
    case "ankiDeckNamePersistTimer":
      return ankiDeckNamePersistTimer;
    case "outputDirectoryPersistTimer":
      return outputDirectoryPersistTimer;
    default:
      return null;
  }
}

function setPersistTimer(timerKey, value) {
  switch (timerKey) {
    case "whisperCliPathPersistTimer":
      whisperCliPathPersistTimer = value;
      break;
    case "whisperModelPathPersistTimer":
      whisperModelPathPersistTimer = value;
      break;
    case "whisperLanguagePersistTimer":
      whisperLanguagePersistTimer = value;
      break;
    case "ankiDeckNamePersistTimer":
      ankiDeckNamePersistTimer = value;
      break;
    case "outputDirectoryPersistTimer":
      outputDirectoryPersistTimer = value;
      break;
    default:
      break;
  }
}

function renderTranscriptionSettings() {
  transcriptionEnabledInput.checked = currentTranscriptionSettings.enabled;
  whisperCliPathInput.value = currentTranscriptionSettings.whisperCliPath;
  whisperModelPathInput.value = currentTranscriptionSettings.whisperModelPath;
  whisperLanguageInput.value = currentTranscriptionSettings.language;
  ankiDeckNameInput.value = currentTranscriptionSettings.ankiDeckName;
  transcriptionFields.classList.toggle(
    "muted-block",
    !currentTranscriptionSettings.enabled
  );
}

function renderTranslationSettings() {
  translationEnabledInput.checked = currentTranslationSettings.enabled;
}

function renderOutputDirectory() {
  outputDirectoryInput.value = currentOutputDirectory;
  pathHint.textContent = currentOutputDirectory
    ? `Saved to ${currentOutputDirectory}`
    : `Saved to Downloads/${DEFAULT_DOWNLOAD_FOLDER}`;
}

function renderRecorderState() {
  const statusText = currentState.errorText || currentState.statusText || "Idle";
  let statusVariant = "idle";

  if (currentState.errorText) {
    statusVariant = "error";
  } else if (currentState.isProcessing) {
    statusVariant = "processing";
  } else if (currentState.isRecording) {
    statusVariant = "recording";
  }

  renderStatus(statusText, statusVariant);
  renderPill(statusVariant);
  renderButtons();
  renderQueueState();
  renderTimer();
  syncTimerInterval();
}

function renderStatus(text, variant) {
  status.textContent = text;
  status.className = `status${variant ? ` ${variant}` : ""}`;
}

function renderPill(variant) {
  const text = currentState.isRecording
    ? "Live"
    : currentState.isProcessing
      ? "Busy"
      : currentState.errorText
        ? "Error"
        : "Idle";

  statePill.textContent = text;
  statePill.className = "pill";

  if (variant === "recording") {
    statePill.classList.add("recording");
  }

  if (variant === "processing") {
    statePill.classList.add("processing");
  }
}

function renderButtons() {
  startBtn.disabled = currentState.isRecording || currentState.isProcessing;
  stopBtn.disabled = !currentState.isRecording;
  startAvTestBtn.disabled =
    avTestRunning || currentState.isRecording || currentState.isProcessing;
}

function renderAvTestStatus(text, variant) {
  avTestStatus.textContent = text;
  avTestStatus.className = `hint${variant === "error" ? " error" : ""}`;
}

function formatBitrate(value) {
  const bitrate = Number(value || 0);
  if (!bitrate) {
    return "unknown";
  }

  if (bitrate >= 1000000) {
    return `${(bitrate / 1000000).toFixed(1)} Mbps`;
  }

  return `${Math.round(bitrate / 1000)} kbps`;
}

function renderQueueState() {
  queueCount.textContent = String(currentQueueState.pendingCount || 0);
  renderQueueStatus(
    currentQueueState.errorText || currentQueueState.statusText || "Queue empty.",
    currentQueueState.errorText ? "error" : "idle"
  );
  pushQueueBtn.disabled =
    currentQueueState.isSyncing ||
    !currentQueueState.pendingCount ||
    currentState.isProcessing;
  pushQueueBtn.textContent = currentQueueState.isSyncing
    ? "Pushing..."
    : "Push to Anki";
}

function renderQueueItems() {
  if (!currentQueueItems.length) {
    queueList.innerHTML = `<p class="queue-empty">No queued cards.</p>`;
    return;
  }

  queueList.innerHTML = currentQueueItems
    .map((item) => {
      const queuedAt = formatQueueTimestamp(item.queuedAt);
      const modeText = item.hasTranslation ? "Transcript + translation" : "Transcript only";
      const retryText =
        Number(item.retryCount || 0) > 0
          ? `Retry ${item.retryCount}`
          : "Ready";

      return `
        <div class="queue-item">
          <div>
            <div class="queue-item-title">${escapeHtml(item.recordingName || "recording")}</div>
            <div class="queue-item-meta">${escapeHtml(modeText)} • ${escapeHtml(retryText)}${queuedAt ? ` • ${escapeHtml(queuedAt)}` : ""}</div>
          </div>
          <button class="queue-item-drop" type="button" data-queue-drop="${escapeHtml(item.jobId || "")}">Drop</button>
        </div>
      `;
    })
    .join("");
}

function renderQueueStatus(text, variant) {
  queueStatus.textContent = text;
  queueStatus.className = `hint${variant === "error" ? " error" : ""}`;
}

function renderTimer() {
  if (currentState.isRecording && currentState.startedAt) {
    timer.textContent = formatElapsedTime(Date.now() - currentState.startedAt);
    return;
  }

  if (currentState.isProcessing) {
    timer.textContent = formatElapsedTime(currentState.lastDurationMs || 0);
    return;
  }

  timer.textContent = formatElapsedTime(0);
}

function syncTimerInterval() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (currentState.isRecording && currentState.startedAt) {
    timerInterval = window.setInterval(() => {
      renderTimer();
    }, 1000);
  }
}

async function refreshQueueState() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "GET_QUEUE_STATUS",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Queue status could not be loaded.");
    }
  } catch (error) {
    renderQueueStatus(
      error.message || "Queue status could not be loaded.",
      "error",
    );
  }
}

async function refreshQueueItems() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "GET_QUEUE_ITEMS",
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Queue items could not be loaded.");
    }

    currentQueueItems = Array.isArray(response.items) ? response.items : [];
    renderQueueItems();
  } catch (error) {
    currentQueueItems = [];
    renderQueueItems();
    renderQueueStatus(
      error.message || "Queue items could not be loaded.",
      "error",
    );
  }
}

function formatQueueTimestamp(value) {
  if (!value) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function requestGoogleTranslatePermission() {
  const permissions = {
    origins: ["https://translate.google.com/*"],
  };

  const hasPermission = await chrome.permissions.contains(permissions);
  if (hasPermission) {
    return true;
  }

  return chrome.permissions.request(permissions);
}
