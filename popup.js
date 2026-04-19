const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const status = document.getElementById("status");
const timer = document.getElementById("timer");
const statePill = document.getElementById("statePill");
const formatSelect = document.getElementById("format");
const downloadFolderInput = document.getElementById("downloadFolder");
const pathHint = document.getElementById("pathHint");
const transcriptionEnabledInput = document.getElementById("transcriptionEnabled");
const whisperCliPathInput = document.getElementById("whisperCliPath");
const whisperModelPathInput = document.getElementById("whisperModelPath");
const browseWhisperCliPathBtn = document.getElementById("browseWhisperCliPath");
const browseWhisperModelPathBtn = document.getElementById("browseWhisperModelPath");
const whisperLanguageInput = document.getElementById("whisperLanguage");
const transcriptionFields = document.getElementById("transcriptionFields");
const queueCount = document.getElementById("queueCount");
const queueStatus = document.getElementById("queueStatus");
const pushQueueBtn = document.getElementById("pushQueue");

let currentState = DEFAULT_RECORDER_STATE;
let currentTranscriptionSettings = DEFAULT_TRANSCRIPTION_SETTINGS;
let currentQueueState = DEFAULT_ANKI_QUEUE_STATE;
let timerInterval = null;
let whisperCliPathPersistTimer = null;
let whisperModelPathPersistTimer = null;
let whisperLanguagePersistTimer = null;

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
  }
});

formatSelect.addEventListener("change", async () => {
  const nextFormat = await setFormat(formatSelect.value);
  formatSelect.value = nextFormat;
});

downloadFolderInput.addEventListener("change", async () => {
  const nextFolder = await setDownloadFolder(downloadFolderInput.value);
  downloadFolderInput.value = nextFolder;
  pathHint.textContent = `Saved to Downloads/${nextFolder}`;
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
  schedulePersistedTextSetting("whisperCliPath", whisperCliPathInput.value);
});

whisperModelPathInput.addEventListener("change", async () => {
  await persistTranscriptionSettings({
    whisperModelPath: whisperModelPathInput.value,
  });
});
whisperModelPathInput.addEventListener("input", () => {
  schedulePersistedTextSetting("whisperModelPath", whisperModelPathInput.value);
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
  schedulePersistedTextSetting("language", whisperLanguageInput.value);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.format) {
    formatSelect.value = changes.format.newValue || DEFAULT_FORMAT;
  }

  if (changes.downloadFolder) {
    const nextFolder = sanitizeDownloadFolder(changes.downloadFolder.newValue);
    downloadFolderInput.value = nextFolder;
    pathHint.textContent = `Saved to Downloads/${nextFolder}`;
  }

  if (changes.transcriptionSettings) {
    currentTranscriptionSettings = normalizeTranscriptionSettings(
      changes.transcriptionSettings.newValue
    );
    renderTranscriptionSettings();
  }

  if (changes.ankiQueueState) {
    currentQueueState = {
      ...DEFAULT_ANKI_QUEUE_STATE,
      ...(changes.ankiQueueState.newValue || {}),
    };
    renderQueueState();
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

  const [format, folder, recorderState, transcriptionSettings, ankiQueueState] =
    await Promise.all([
      getFormat(),
      getDownloadFolder(),
      getRecorderState(),
      getTranscriptionSettings(),
      getAnkiQueueState(),
    ]);

  formatSelect.value = format;
  downloadFolderInput.value = folder;
  pathHint.textContent = `Saved to Downloads/${folder}`;
  currentState = recorderState;
  currentTranscriptionSettings = transcriptionSettings;
  currentQueueState = ankiQueueState;

  renderTranscriptionSettings();
  renderQueueState();
  renderRecorderState();
  await refreshQueueState();
}

async function persistTranscriptionSettings(partialSettings) {
  currentTranscriptionSettings = await updateTranscriptionSettings(partialSettings);
  renderTranscriptionSettings();
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

function schedulePersistedTextSetting(key, value) {
  const timerKey = `${key}PersistTimer`;
  const existingTimer = getPersistTimer(timerKey);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const nextTimer = window.setTimeout(async () => {
    setPersistTimer(timerKey, null);
    await persistTranscriptionSettings({
      [key]: value,
    });
  }, 250);

  setPersistTimer(timerKey, nextTimer);
}

function getPersistTimer(timerKey) {
  switch (timerKey) {
    case "whisperCliPathPersistTimer":
      return whisperCliPathPersistTimer;
    case "whisperModelPathPersistTimer":
      return whisperModelPathPersistTimer;
    case "whisperLanguagePersistTimer":
      return whisperLanguagePersistTimer;
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
    default:
      break;
  }
}

function renderTranscriptionSettings() {
  transcriptionEnabledInput.checked = currentTranscriptionSettings.enabled;
  whisperCliPathInput.value = currentTranscriptionSettings.whisperCliPath;
  whisperModelPathInput.value = currentTranscriptionSettings.whisperModelPath;
  whisperLanguageInput.value = currentTranscriptionSettings.language;
  transcriptionFields.classList.toggle(
    "muted-block",
    !currentTranscriptionSettings.enabled
  );
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
