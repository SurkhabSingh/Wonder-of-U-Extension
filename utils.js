const DEFAULT_FORMAT = "webm";
const DEFAULT_DOWNLOAD_FOLDER = "TabRecordings";
const DEFAULT_ANKI_DECK_NAME = "Audio Immersion";
const DEFAULT_OUTPUT_DIRECTORY = "";
const DEFAULT_TRANSCRIPTION_SETTINGS = {
  enabled: false,
  whisperCliPath: "",
  whisperModelPath: "",
  language: "auto",
  ankiDeckName: DEFAULT_ANKI_DECK_NAME,
};
const DEFAULT_TRANSLATION_SETTINGS = {
  enabled: false,
};
const DEFAULT_ANKI_QUEUE_STATE = {
  pendingCount: 0,
  isSyncing: false,
  statusText: "Queue empty.",
  errorText: "",
  lastUpdatedAt: null,
};
const DEFAULT_RECORDER_STATE = {
  isRecording: false,
  isProcessing: false,
  startedAt: null,
  stoppedAt: null,
  targetTabId: null,
  lastDurationMs: 0,
  lastAudioPath: null,
  lastTranscriptPath: null,
  statusText: "Idle",
  errorText: "",
};
const WHISPER_LANGUAGE_ALIASES = {
  auto: "auto",
  en: "en",
  english: "en",
  ja: "ja",
  jp: "ja",
  japanese: "ja",
  "\u65e5\u672c\u8a9e": "ja",
};

const RECORDING_DB_NAME = "tab-audio-recorder";
const RECORDING_STORE_NAME = "recordings";
async function ensureSettings() {
  const data = await chrome.storage.local.get([
    "format",
    "downloadFolder",
    "outputDirectory",
    "count",
    "recorderState",
    "transcriptionSettings",
    "translationSettings",
    "ankiQueueState",
  ]);

  const updates = {};

  if (!data.format) {
    updates.format = DEFAULT_FORMAT;
  }

  if (!data.downloadFolder) {
    updates.downloadFolder = DEFAULT_DOWNLOAD_FOLDER;
  }

  if (typeof data.outputDirectory !== "string") {
    updates.outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  }

  if (typeof data.count !== "number") {
    updates.count = 1;
  }

  if (!data.recorderState) {
    updates.recorderState = DEFAULT_RECORDER_STATE;
  }

  if (!data.ankiQueueState) {
    updates.ankiQueueState = DEFAULT_ANKI_QUEUE_STATE;
  }

  if (!data.translationSettings) {
    updates.translationSettings = DEFAULT_TRANSLATION_SETTINGS;
  }

  const normalizedTranscriptionSettings =
    !data.transcriptionSettings
      ? DEFAULT_TRANSCRIPTION_SETTINGS
      : migrateTranscriptionSettings(data.transcriptionSettings);

  if (
    !data.transcriptionSettings ||
    JSON.stringify(normalizedTranscriptionSettings) !==
      JSON.stringify(data.transcriptionSettings)
  ) {
    updates.transcriptionSettings = normalizedTranscriptionSettings;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function getFormat() {
  const data = await chrome.storage.local.get("format");
  return data.format || DEFAULT_FORMAT;
}

async function setFormat(format) {
  const nextFormat =
    format === "mp3" || format === "wav" ? format : DEFAULT_FORMAT;
  await chrome.storage.local.set({ format: nextFormat });
  return nextFormat;
}

function sanitizeDownloadFolder(folder) {
  const normalized = String(folder || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");

  return normalized || DEFAULT_DOWNLOAD_FOLDER;
}

async function getDownloadFolder() {
  const data = await chrome.storage.local.get("downloadFolder");
  return sanitizeDownloadFolder(data.downloadFolder);
}

async function setDownloadFolder(folder) {
  const nextFolder = sanitizeDownloadFolder(folder);
  await chrome.storage.local.set({ downloadFolder: nextFolder });
  return nextFolder;
}

async function getOutputDirectory() {
  const data = await chrome.storage.local.get("outputDirectory");
  return sanitizeLocalPath(data.outputDirectory);
}

async function setOutputDirectory(directory) {
  const nextDirectory = sanitizeLocalPath(directory);
  await chrome.storage.local.set({ outputDirectory: nextDirectory });
  return nextDirectory;
}

async function getNextFilename(ext, requestedName) {
  const data = await chrome.storage.local.get(["count", "downloadFolder"]);
  const count = typeof data.count === "number" ? data.count : 1;
  const folder = sanitizeDownloadFolder(data.downloadFolder);
  const extension = ext === "mp3" || ext === "wav" ? ext : "webm";
  const customName = sanitizeRecordingName(requestedName);
  const baseName = customName || `recording_${count}`;
  const filename = `${folder}/${baseName}.${extension}`;
  const updates = {
    downloadFolder: folder,
  };

  if (!customName) {
    updates.count = count + 1;
  }

  await chrome.storage.local.set(updates);

  return filename;
}

async function getTranscriptionSettings() {
  const data = await chrome.storage.local.get("transcriptionSettings");
  return normalizeTranscriptionSettings(data.transcriptionSettings);
}

async function updateTranscriptionSettings(partialSettings) {
  const currentSettings = await getTranscriptionSettings();
  const nextSettings = normalizeTranscriptionSettings({
    ...currentSettings,
    ...(partialSettings || {}),
  });

  await chrome.storage.local.set({ transcriptionSettings: nextSettings });
  return nextSettings;
}

async function getTranslationSettings() {
  const data = await chrome.storage.local.get("translationSettings");
  return normalizeTranslationSettings(data.translationSettings);
}

async function updateTranslationSettings(partialSettings) {
  const currentSettings = await getTranslationSettings();
  const nextSettings = normalizeTranslationSettings({
    ...currentSettings,
    ...(partialSettings || {}),
  });

  await chrome.storage.local.set({ translationSettings: nextSettings });
  return nextSettings;
}

function normalizeTranscriptionSettings(settings) {
  return {
    enabled: Boolean(settings?.enabled),
    whisperCliPath: sanitizeLocalPath(settings?.whisperCliPath),
    whisperModelPath: sanitizeLocalPath(settings?.whisperModelPath),
    language: sanitizeLanguage(settings?.language),
    ankiDeckName: sanitizeAnkiDeckName(settings?.ankiDeckName),
  };
}

function normalizeTranslationSettings(settings) {
  return {
    enabled: Boolean(settings?.enabled),
  };
}

function migrateTranscriptionSettings(settings) {
  const looksUnconfigured =
    settings &&
    settings.enabled === false &&
    !String(settings.whisperCliPath || "").trim() &&
    !String(settings.whisperModelPath || "").trim() &&
    (!settings.language || settings.language === "auto");

  if (looksUnconfigured) {
    return DEFAULT_TRANSCRIPTION_SETTINGS;
  }

  return normalizeTranscriptionSettings(settings);
}
function sanitizeLanguage(language) {
  const normalized = String(language || "").trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_TRANSCRIPTION_SETTINGS.language;
  }

  return WHISPER_LANGUAGE_ALIASES[normalized] || normalized;
}

function sanitizeLocalPath(path) {
  return String(path || "").trim();
}

function sanitizeAnkiDeckName(deckName) {
  const normalized = String(deckName || "").trim();
  return normalized || DEFAULT_ANKI_DECK_NAME;
}

function sanitizeRecordingName(name) {
  const withoutExtension = stripFileExtension(String(name || "").trim());

  return withoutExtension
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

function getTranscriptionConfigurationError(settings) {
  if (!settings.enabled) {
    return "";
  }

  if (!settings.whisperCliPath) {
    return "Add the local whisper-cli path to enable transcription.";
  }

  if (!settings.whisperModelPath) {
    return "Add the local Whisper model path to enable transcription.";
  }

  return "";
}

async function getRecorderState() {
  const data = await chrome.storage.local.get("recorderState");
  return {
    ...DEFAULT_RECORDER_STATE,
    ...(data.recorderState || {}),
  };
}

async function setRecorderState(partialState) {
  const currentState = await getRecorderState();
  const nextState = {
    ...currentState,
    ...partialState,
  };

  await chrome.storage.local.set({ recorderState: nextState });
  return nextState;
}

async function getAnkiQueueState() {
  const data = await chrome.storage.local.get("ankiQueueState");
  return {
    ...DEFAULT_ANKI_QUEUE_STATE,
    ...(data.ankiQueueState || {}),
  };
}

async function setAnkiQueueState(partialState) {
  const currentState = await getAnkiQueueState();
  const nextState = {
    ...currentState,
    ...partialState,
  };

  await chrome.storage.local.set({ ankiQueueState: nextState });
  return nextState;
}

function formatElapsedTime(durationMs) {
  const totalSeconds = Math.max(0, Math.floor((durationMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stripFileExtension(filePath) {
  return String(filePath || "").replace(/\.[^./\\]+$/, "");
}

function getFileStem(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const segments = normalized.split("/");
  return stripFileExtension(segments[segments.length - 1] || "recording");
}

function getFilenameFromPath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || "";
}

function buildTemporaryWavFilename(primaryRelativeFilename) {
  const normalized = String(primaryRelativeFilename || "").replace(/\\/g, "/");
  const lastSlashIndex = normalized.lastIndexOf("/");
  const directory = lastSlashIndex >= 0 ? normalized.slice(0, lastSlashIndex) : "";
  const basename = normalized.slice(lastSlashIndex + 1);
  const stem = getFileStem(basename);
  const tempDirectory = directory
    ? `${directory}/_transcription`
    : "_transcription";

  return `${tempDirectory}/${stem}.whisper-source.wav`;
}

function openRecordingDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECORDING_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDING_STORE_NAME)) {
        db.createObjectStore(RECORDING_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Unable to open recording database."));
  });
}

async function saveRecordingBlob(blob) {
  const db = await openRecordingDatabase();
  const key = `recording-${Date.now()}-${crypto.randomUUID()}`;

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDING_STORE_NAME, "readwrite");
    const store = transaction.objectStore(RECORDING_STORE_NAME);

    store.put(blob, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () =>
      reject(
        transaction.error || new Error("Unable to store recording data.")
      );
    transaction.onabort = () =>
      reject(transaction.error || new Error("Recording storage was aborted."));
  });

  db.close();
  return key;
}

async function getRecordingBlob(key) {
  const db = await openRecordingDatabase();

  const blob = await new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDING_STORE_NAME, "readonly");
    const store = transaction.objectStore(RECORDING_STORE_NAME);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () =>
      reject(request.error || new Error("Unable to read recording data."));
  });

  db.close();
  return blob;
}

async function deleteRecordingBlob(key) {
  const db = await openRecordingDatabase();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDING_STORE_NAME, "readwrite");
    const store = transaction.objectStore(RECORDING_STORE_NAME);

    store.delete(key);
    transaction.oncomplete = resolve;
    transaction.onerror = () =>
      reject(transaction.error || new Error("Unable to clear recording data."));
    transaction.onabort = () =>
      reject(transaction.error || new Error("Recording cleanup was aborted."));
  });

  db.close();
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return `data:${getDataUrlMimeType(blob.type)};base64,${btoa(binary)}`;
}

function getDataUrlMimeType(mimeType) {
  const normalized = String(mimeType || "").trim();
  if (!normalized) {
    return "application/octet-stream";
  }

  const baseType = normalized.split(";")[0].trim().toLowerCase();
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(baseType)) {
    return baseType;
  }

  return "application/octet-stream";
}

async function convertToMP3(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const samples = downmixToMono(audioBuffer);
  const mp3encoder = new lamejs.Mp3Encoder(1, audioBuffer.sampleRate, 128);
  const mp3Data = [];
  const sampleBlockSize = 1152;

  for (let index = 0; index < samples.length; index += sampleBlockSize) {
    const sampleChunk = samples.subarray(index, index + sampleBlockSize);
    const buffer = mp3encoder.encodeBuffer(floatTo16BitPCM(sampleChunk));
    if (buffer.length > 0) {
      mp3Data.push(buffer);
    }
  }

  const end = mp3encoder.flush();
  if (end.length > 0) {
    mp3Data.push(end);
  }

  await audioContext.close();

  return new Blob(mp3Data, { type: "audio/mpeg" });
}

async function convertToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const wavBuffer = encodeWav(audioBuffer);

  await audioContext.close();

  return new Blob([wavBuffer], { type: "audio/wav" });
}

function encodeWav(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataLength = samples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const channels = [];

  for (let channel = 0; channel < channelCount; channel += 1) {
    channels.push(audioBuffer.getChannelData(channel));
  }

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;

  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][sampleIndex]));
      const pcmValue = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, pcmValue, true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function downmixToMono(audioBuffer) {
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }

  const mono = new Float32Array(audioBuffer.length);

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const samples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) {
      mono[index] += samples[index] / audioBuffer.numberOfChannels;
    }
  }

  return mono;
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
}
