const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");

const ANKI_CONNECT_VERSION = 5;
const DEFAULT_ANKI_TAGS = ["audio-recorder", "audio-immersion"];
const LOCALHOST_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ALLOWED_WHISPER_EXECUTABLES = new Set(["whisper-cli", "whisper-cli.exe"]);
const APP_DATA_DIR =
  process.env.AUDIO_RECORDER_HOST_DATA_DIR ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "AudioRecorderNative",
  );
const ANKI_QUEUE_FILE = path.join(APP_DATA_DIR, "anki-queue.json");
const QUEUED_MEDIA_DIR = path.join(APP_DATA_DIR, "queued-media");

// Message types owned by the translation bridge worker rather than the one-shot
// request handlers below.
const BRIDGE_MESSAGE_TYPES = new Set([
  "bridge-start",
  "bridge-stop",
  "bridge-result",
  "bridge-fail",
]);

let pendingOperations = 0;
let inputEnded = false;

main();

// The host serves two callers over the same stdio framing:
//
//   * `chrome.runtime.sendNativeMessage` spawns us, writes one request, reads one
//     reply, and closes stdin. That is the transcription/Anki path, unchanged.
//   * `chrome.runtime.connectNative` keeps the process alive for the life of the
//     port. That is the translation bridge, and it is the whole reason this is a
//     message loop rather than a single read: an open native port is the only
//     thing Chrome documents as keeping an MV3 service worker alive, cancelling
//     both the 30s idle timeout and the 5-minute cap. Holding the loopback HTTP
//     here (instead of in the worker) also means Chrome's fetch limits, CORS, and
//     Local Network Access never apply to it.
function main() {
  startNativeMessageStream({
    onMessage: (message) => {
      dispatchNativeMessage(message);
    },
    // Chrome closes stdin when it disconnects the port (or when a one-shot
    // request is done). Either way there is nobody left to serve, so stop the
    // bridge — without this the worker keeps polling and the process never exits,
    // leaking a node process for every App-Support session.
    onEnd: () => {
      inputEnded = true;
      TranslationBridgeWorker.stop();
      maybeExit();
    },
    onError: () => {
      inputEnded = true;
      TranslationBridgeWorker.stop();
      maybeExit();
    },
  });
}

function dispatchNativeMessage(message) {
  if (BRIDGE_MESSAGE_TYPES.has(message?.type)) {
    TranslationBridgeWorker.handle(message);
    return;
  }

  pendingOperations += 1;

  handleNativeMessage(message)
    .then((payload) => {
      writeNativeMessage({ ok: true, ...payload });
    })
    .catch((error) => {
      writeNativeMessage({
        ok: false,
        error: error?.message || "Native host failed.",
      });
    })
    .finally(() => {
      pendingOperations -= 1;
      maybeExit();
    });
}

// Chrome closes stdin once a one-shot request is answered. Stay alive while a
// reply is still in flight, and while the bridge port is connected.
function maybeExit() {
  if (inputEnded && pendingOperations === 0 && !TranslationBridgeWorker.isRunning()) {
    process.exit(0);
  }
}

async function handleNativeMessage(message) {
  if (message?.type === "queue-status") {
    return getAnkiQueueStatus();
  }

  if (message?.type === "flush-anki-queue") {
    return flushAnkiQueue();
  }

  if (message?.type === "queue-items") {
    return getAnkiQueueItems();
  }

  if (message?.type === "drop-queue-item") {
    return dropAnkiQueueItem(message);
  }

  if (message?.type === "move-file") {
    return moveFile(message);
  }

  if (message?.type === "pick-path") {
    return pickPath(message);
  }

  if (message?.type === "list-anki-decks") {
    return listAnkiDecks(message);
  }

  if (message?.type === "list-anki-note-types") {
    return listAnkiNoteTypes(message);
  }

  if (message?.type === "list-anki-fields") {
    return listAnkiFields(message);
  }

  if (message?.type === "queue-anki-card") {
    return queueStandaloneAnkiCard(message);
  }

  if (message?.type === "create-anki-card") {
    return createStandaloneAnkiCard(message);
  }

  if (message?.type !== "process-recording") {
    throw new Error("Unsupported native host request.");
  }

  const job = normalizeJob(message);
  const result = await runWhisperTranscription(job);
  const transcriptText = await readTranscriptText(result.transcriptPath);

  const queueStatus = await getAnkiQueueStatus();

  return {
    transcriptPath: result.transcriptPath,
    transcriptText,
    anki: { status: "skipped" },
    pendingCount: queueStatus.pendingCount,
  };
}

async function pickPath(message) {
  const request = normalizePathPickerRequest(message);
  const selectedPath = await showPathPicker(request);

  return {
    selectedPath,
  };
}

async function moveFile(message) {
  const request = normalizeMoveFileRequest(message);
  const destinationPath = await moveFileToDirectory(request);

  return {
    destinationPath,
  };
}

async function createStandaloneAnkiCard(message) {
  const request = normalizeAnkiCardRequest(message);
  const ankiJob = await buildAnkiJob(
    {
      audioPath: request.audioPath,
      recordingName: request.recordingName,
      anki: request.anki,
    },
    request.transcriptPath,
    {
      transcriptText: request.transcriptText,
      translatedText: request.translatedText,
      jobId: request.jobId,
    },
  );
  let anki = await createAnkiCard(ankiJob);

  if (anki.status === "offline") {
    const queueResult = await enqueueAnkiJob(ankiJob);
    anki = {
      status: "queued",
      message: "Anki offline. Card queued for later.",
      queueId: queueResult.jobId,
    };
  }

  const queueStatus = await getAnkiQueueStatus();

  return {
    anki,
    pendingCount: queueStatus.pendingCount,
  };
}

async function queueStandaloneAnkiCard(message) {
  const request = normalizeAnkiCardRequest(message);
  const ankiJob = await buildAnkiJob(
    {
      audioPath: request.audioPath,
      recordingName: request.recordingName,
      anki: request.anki,
    },
    request.transcriptPath,
    {
      transcriptText: request.transcriptText,
      translatedText: request.translatedText,
      jobId: request.jobId,
    },
  );
  const queueResult = await enqueueAnkiJob(ankiJob);

  return {
    anki: {
      status: "queued",
      message: "Card queued for manual push.",
      queueId: queueResult.jobId,
    },
    pendingCount: queueResult.pendingCount,
  };
}

function normalizeJob(message) {
  const whisperCliPath = String(message?.whisperCliPath || "").trim();
  const whisperModelPath = String(message?.whisperModelPath || "").trim();
  const audioPath = String(message?.audioPath || "").trim();
  const transcriptPath = String(message?.transcriptPath || "").trim();
  const language = String(message?.language || "auto")
    .trim()
    .toLowerCase();
  const recordingName = sanitizeName(message?.recordingName || "");
  const anki = normalizeAnkiConfig(message?.anki);

  if (!whisperCliPath) {
    throw new Error("Missing whisper-cli path.");
  }

  if (!whisperModelPath) {
    throw new Error("Missing Whisper model path.");
  }

  if (!audioPath) {
    throw new Error("Missing audio file path.");
  }

  if (!transcriptPath) {
    throw new Error("Missing transcript output path.");
  }

  if (!path.isAbsolute(whisperCliPath)) {
    throw new Error("whisper-cli path must be absolute.");
  }

  if (!path.isAbsolute(whisperModelPath)) {
    throw new Error("Whisper model path must be absolute.");
  }

  if (!path.isAbsolute(audioPath) || !path.isAbsolute(transcriptPath)) {
    throw new Error("Audio and transcript paths must be absolute.");
  }

  const executableName = path.basename(whisperCliPath).toLowerCase();
  if (!ALLOWED_WHISPER_EXECUTABLES.has(executableName)) {
    throw new Error("The configured executable must be whisper-cli.");
  }

  if (path.extname(whisperModelPath).toLowerCase() !== ".bin") {
    throw new Error("The configured model must be a .bin Whisper model file.");
  }

  return {
    whisperCliPath,
    whisperModelPath,
    audioPath,
    transcriptPath,
    language: language || "auto",
    recordingName,
    anki,
  };
}

function normalizeAnkiConfig(anki) {
  const connectUrl = String(anki?.connectUrl || "http://127.0.0.1:8765").trim();
  let parsedUrl;

  try {
    parsedUrl = new URL(connectUrl);
  } catch (error) {
    throw new Error("AnkiConnect URL is invalid.");
  }

  if (
    parsedUrl.protocol !== "http:" ||
    !LOCALHOST_HOSTS.has(parsedUrl.hostname)
  ) {
    throw new Error("AnkiConnect must point to localhost.");
  }

  parsedUrl.pathname = "/";
  parsedUrl.search = "";
  parsedUrl.hash = "";

  const modelName =
    String(anki?.modelName || anki?.noteType || "Basic").trim() || "Basic";

  // The field map is authoritative when present. Older callers (and older queued
  // jobs on disk) only knew about frontField/backField, so fall back to those so
  // an existing queue still pushes after an upgrade.
  const legacyFront = String(anki?.frontField || "Front").trim() || "Front";
  const legacyBack = String(anki?.backField || "Back").trim() || "Back";
  const mapped = anki?.fields;

  const fields = mapped
    ? {
        audio: String(mapped.audio || "").trim(),
        transcription: String(mapped.transcription || "").trim(),
        translation: String(mapped.translation || "").trim(),
        sourcePath: String(mapped.sourcePath || "").trim(),
        createdAt: String(mapped.createdAt || "").trim(),
      }
    : {
        audio: legacyFront,
        transcription: legacyBack,
        translation: "",
        sourcePath: "",
        createdAt: "",
      };

  return {
    enabled: Boolean(anki?.enabled),
    connectUrl: parsedUrl.toString(),
    deckName: String(anki?.deckName || "Audio Immersion").trim() || "Audio Immersion",
    modelName,
    fields,
  };
}

function normalizePathPickerRequest(message) {
  const kind =
    message?.kind === "model"
      ? "model"
      : message?.kind === "output-directory"
        ? "output-directory"
        : "cli";
  const currentPath = String(message?.currentPath || "").trim();

  return {
    kind,
    currentPath,
    title:
      kind === "output-directory"
        ? "Select output folder"
        : kind === "model"
        ? "Select Whisper model file"
        : "Select whisper-cli executable",
    filter:
      kind === "output-directory"
        ? ""
        : kind === "model"
        ? "Whisper model (*.bin)|*.bin|All files (*.*)|*.*"
        : "Executable (*.exe)|*.exe|All files (*.*)|*.*",
  };
}

function normalizeMoveFileRequest(message) {
  const sourcePath = String(message?.sourcePath || "").trim();
  const targetDirectory = String(message?.targetDirectory || "").trim();
  const targetFilename = path.basename(String(message?.targetFilename || "").trim());

  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new Error("The source file path is invalid.");
  }

  if (!targetDirectory || !path.isAbsolute(targetDirectory)) {
    throw new Error("The selected save folder is invalid.");
  }

  if (!targetFilename) {
    throw new Error("The target file name is invalid.");
  }

  return {
    sourcePath,
    targetDirectory,
    targetFilename,
  };
}

function normalizeAnkiCardRequest(message) {
  const audioPath = String(message?.audioPath || "").trim();
  const transcriptPath = String(message?.transcriptPath || "").trim();
  const transcriptText = String(message?.transcriptText || "");
  const translatedText = String(message?.translatedText || "");
  const recordingName = sanitizeName(message?.recordingName || "");
  const anki = normalizeAnkiConfig(message?.anki);
  const jobId = String(message?.jobId || "").trim();

  if (!audioPath || !path.isAbsolute(audioPath)) {
    throw new Error("The audio file path is invalid.");
  }

  if (!transcriptPath || !path.isAbsolute(transcriptPath)) {
    throw new Error("The transcript path is invalid.");
  }

  return {
    audioPath,
    transcriptPath,
    transcriptText,
    translatedText,
    recordingName,
    anki,
    jobId,
  };
}

async function runWhisperTranscription(job) {
  await assertFileExists(job.whisperCliPath, "whisper-cli was not found.");
  await assertFileExists(job.whisperModelPath, "The Whisper model file was not found.");
  await assertFileExists(job.audioPath, "The saved audio file was not found.");

  await fs.promises.mkdir(path.dirname(job.transcriptPath), { recursive: true });

  const outputBasePath = stripTxtExtension(job.transcriptPath);
  const args = [
    "--model",
    job.whisperModelPath,
    "--file",
    job.audioPath,
    "--output-file",
    outputBasePath,
    "--output-txt",
  ];

  if (job.language !== "auto") {
    args.push("--language", job.language);
  }

  const result = await spawnProcess(job.whisperCliPath, args);
  const transcriptPath = `${outputBasePath}.txt`;

  await assertFileExists(
    transcriptPath,
    `whisper.cpp finished, but no transcript file was created.\n${result.stderr || result.stdout || "No output was captured."}`,
  );

  return {
    transcriptPath,
  };
}

async function buildAnkiJob(job, transcriptPath, options = {}) {
  const jobId = options.jobId || job.jobId || buildJobId();
  const transcriptText =
    String(options.transcriptText || "").trim() || (await readTranscriptText(transcriptPath));
  const translatedText = normalizeMultilineText(options.translatedText);

  return {
    jobId,
    connectUrl: job.anki.connectUrl,
    deckName: job.anki.deckName,
    modelName: job.anki.modelName,
    fields: job.anki.fields,
    recordingName:
      job.recordingName || sanitizeName(path.basename(job.audioPath, path.extname(job.audioPath))),
    audioPath: job.audioPath,
    transcriptPath,
    transcriptText,
    translatedText,
    transcriptHtml: formatTranscriptForAnkiField(transcriptText, translatedText),
    mediaFilename:
      job.mediaFilename || buildAnkiMediaFilename(job.audioPath, job.recordingName),
    tags: job.tags || [...DEFAULT_ANKI_TAGS, buildJobTag(jobId)],
  };
}

// Fills only the roles the user actually mapped. An unmapped role is skipped
// entirely rather than written as an empty string, so it cannot clobber a field
// the user populates elsewhere.
//
// The one special case is translation: if there is a translation but no field to
// put it in, it is appended to the transcript rather than thrown away — that is
// what this extension did before mapping existed, and silently losing a
// translation would be worse than putting it somewhere reasonable.
function buildAnkiNoteFields(job) {
  const map = job.fields || {};
  const fields = {};
  const translation = normalizeMultilineText(job.translatedText);
  const foldTranslationIn = Boolean(translation) && !map.translation;

  if (map.audio) {
    fields[map.audio] = `[sound:${job.mediaFilename}]`;
  }

  if (map.transcription) {
    const transcript = foldTranslationIn
      ? formatTranscriptForAnkiField(job.transcriptText, translation)
      : formatTranscriptForAnkiField(job.transcriptText);

    fields[map.transcription] = transcript || "(Transcript unavailable)";
  }

  if (map.translation && translation) {
    fields[map.translation] = formatTranscriptForAnkiField(translation);
  }

  if (map.sourcePath) {
    fields[map.sourcePath] = escapeHtml(job.audioPath || "");
  }

  if (map.createdAt) {
    fields[map.createdAt] = new Date().toISOString();
  }

  // AnkiConnect rejects a note with no fields at all, and a note with nothing in
  // it would be useless anyway.
  if (Object.keys(fields).length === 0) {
    throw new Error(
      "No Anki fields are mapped. Choose which fields to fill in the extension popup.",
    );
  }

  return fields;
}

async function createAnkiCard(job) {
  try {
    await invokeAnki(job.connectUrl, "version");
  } catch (error) {
    return {
      status: "offline",
      message: "Anki offline",
    };
  }

  try {
    const existingNoteIds = await findExistingQueuedNotes(job);
    if (existingNoteIds.length > 0) {
      return {
        status: "duplicate",
        noteIds: existingNoteIds,
      };
    }

    const audioData = await fs.promises.readFile(job.audioPath, {
      encoding: "base64",
    });

    const deckNames = await invokeAnki(job.connectUrl, "deckNames");
    if (!Array.isArray(deckNames) || !deckNames.includes(job.deckName)) {
      throw new Error("The Anki deck name is incorrect.");
    }

    await invokeAnki(job.connectUrl, "storeMediaFile", {
      filename: job.mediaFilename,
      data: audioData,
    });

    const noteId = await invokeAnki(job.connectUrl, "addNote", {
      note: {
        deckName: job.deckName,
        modelName: job.modelName,
        fields: buildAnkiNoteFields(job),
        options: {
          allowDuplicate: true,
        },
        tags: job.tags,
      },
    });

    if (!noteId) {
      throw new Error("Anki did not create a note.");
    }

    return {
      status: "created",
      noteId,
      mediaFilename: job.mediaFilename,
    };
  } catch (error) {
    if (isAnkiUnavailableError(error)) {
      return {
        status: "offline",
        message: "Anki offline",
      };
    }

    return {
      status: "error",
      message: error?.message || "Anki card creation failed.",
    };
  }
}

async function findExistingQueuedNotes(job) {
  return invokeAnki(job.connectUrl, "findNotes", {
    query: `tag:${buildJobTag(job.jobId)}`,
  });
}

async function enqueueAnkiJob(job) {
  const queue = await readAnkiQueue();
  const existingIndex = queue.findIndex((item) => item.jobId === job.jobId);

  if (existingIndex === -1) {
    const queuedAudioPath = await copyQueuedAudioFile(job);
    queue.push({
      ...job,
      audioPath: queuedAudioPath,
      queuedAt: new Date().toISOString(),
      retryCount: 0,
      lastError: "",
      lastTriedAt: null,
    });
  }

  await writeAnkiQueue(queue);

  return {
    jobId: job.jobId,
    pendingCount: queue.length,
  };
}

async function flushAnkiQueue() {
  const queue = await readAnkiQueue();

  if (queue.length === 0) {
    return {
      status: "empty",
      createdCount: 0,
      failedCount: 0,
      pendingCount: 0,
      remainingCount: 0,
    };
  }

  try {
    await invokeAnki(queue[0].connectUrl, "version");
  } catch (error) {
    return {
      status: "offline",
      createdCount: 0,
      failedCount: 0,
      pendingCount: queue.length,
      remainingCount: queue.length,
      message: "Anki offline",
    };
  }

  const remainingQueue = [];
  let createdCount = 0;
  let failedCount = 0;
  let wentOffline = false;

  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    const result = await createAnkiCard(item);

    if (result.status === "created" || result.status === "duplicate") {
      createdCount += 1;
      await cleanupQueuedAudioFile(item.audioPath);
      continue;
    }

    const updatedItem = {
      ...item,
      retryCount: Number(item.retryCount || 0) + 1,
      lastError: result.message || "Queued Anki push failed.",
      lastTriedAt: new Date().toISOString(),
    };

    if (result.status === "offline") {
      remainingQueue.push(updatedItem, ...queue.slice(index + 1));
      wentOffline = true;
      break;
    }

    failedCount += 1;
    remainingQueue.push(updatedItem);
  }

  await writeAnkiQueue(remainingQueue);

  return {
    status: wentOffline
      ? "offline"
      : failedCount > 0
        ? createdCount > 0
          ? "partial"
          : "error"
        : createdCount > 0
          ? "created"
          : "empty",
    createdCount,
    failedCount,
    pendingCount: remainingQueue.length,
    remainingCount: remainingQueue.length,
  };
}

async function getAnkiQueueStatus() {
  const queue = await readAnkiQueue();

  return {
    pendingCount: queue.length,
  };
}

async function getAnkiQueueItems() {
  const queue = await readAnkiQueue();

  return {
    pendingCount: queue.length,
    items: queue.map((item) => ({
      jobId: item.jobId,
      recordingName: item.recordingName || "recording",
      queuedAt: item.queuedAt || "",
      retryCount: Number(item.retryCount || 0),
      lastError: item.lastError || "",
      hasTranslation: Boolean(String(item.translatedText || "").trim()),
    })),
  };
}

async function dropAnkiQueueItem(message) {
  const jobId = String(message?.jobId || "").trim().toLowerCase();
  if (!jobId) {
    throw new Error("The queued recording ID is missing.");
  }

  const queue = await readAnkiQueue();
  const keptItems = [];

  for (const item of queue) {
    if (String(item.jobId || "").trim().toLowerCase() === jobId) {
      await cleanupQueuedAudioFile(item.audioPath);
      continue;
    }

    keptItems.push(item);
  }

  await writeAnkiQueue(keptItems);

  return {
    pendingCount: keptItems.length,
    items: keptItems.map((item) => ({
      jobId: item.jobId,
      recordingName: item.recordingName || "recording",
      queuedAt: item.queuedAt || "",
      retryCount: Number(item.retryCount || 0),
      lastError: item.lastError || "",
      hasTranslation: Boolean(String(item.translatedText || "").trim()),
    })),
  };
}

async function readAnkiQueue() {
  try {
    const raw = await fs.promises.readFile(ANKI_QUEUE_FILE, "utf8");
    const normalized = raw.replace(/^\uFEFF/, "").trim();

    if (!normalized) {
      return [];
    }

    const parsed = JSON.parse(normalized);

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw new Error("Could not read the Anki queue.");
  }
}

async function writeAnkiQueue(queue) {
  await fs.promises.mkdir(QUEUED_MEDIA_DIR, { recursive: true });
  await fs.promises.writeFile(
    ANKI_QUEUE_FILE,
    JSON.stringify(queue, null, 2),
    "utf8",
  );
}

async function copyQueuedAudioFile(job) {
  const extension = path.extname(job.audioPath).toLowerCase() || ".wav";
  const filename = `${job.jobId}_${sanitizeName(job.recordingName) || "recording"}${extension}`;
  const destinationPath = path.join(QUEUED_MEDIA_DIR, filename);

  await fs.promises.mkdir(QUEUED_MEDIA_DIR, { recursive: true });
  await fs.promises.copyFile(job.audioPath, destinationPath);

  return destinationPath;
}

async function cleanupQueuedAudioFile(filePath) {
  if (!filePath || !filePath.startsWith(QUEUED_MEDIA_DIR)) {
    return;
  }

  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("Could not remove queued audio file:", error);
    }
  }
}

function buildAnkiMediaFilename(audioPath, recordingName) {
  const extension = path.extname(audioPath).toLowerCase() || ".wav";
  const baseName =
    sanitizeName(recordingName) ||
    sanitizeName(path.basename(audioPath, extension)) ||
    "recording";

  return `audio_recorder_${Date.now()}_${baseName}${extension}`;
}

function buildJobId() {
  return `${Date.now()}-${randomUUID()}`;
}

function buildJobTag(jobId) {
  return `audio-recorder-job-${String(jobId || "").toLowerCase()}`;
}

async function showPathPicker(request) {
  if (process.platform !== "win32") {
    throw new Error("Path browsing is currently supported only on Windows.");
  }

  if (request.kind === "output-directory") {
    return showDirectoryPicker(request);
  }

  const currentPath = String(request.currentPath || "").trim();
  const initialDirectory =
    currentPath && path.isAbsolute(currentPath)
      ? path.dirname(currentPath)
      : "";
  const initialFilename =
    currentPath && path.isAbsolute(currentPath)
      ? path.basename(currentPath)
      : "";

  const command = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    `$dialog.Title = '${escapePowerShellString(request.title)}'`,
    `$dialog.Filter = '${escapePowerShellString(request.filter)}'`,
    "$dialog.CheckFileExists = $true",
    "$dialog.Multiselect = $false",
    "$dialog.RestoreDirectory = $true",
    initialDirectory
      ? `$dialog.InitialDirectory = '${escapePowerShellString(initialDirectory)}'`
      : "",
    initialFilename
      ? `$dialog.FileName = '${escapePowerShellString(initialFilename)}'`
      : "",
    "$result = $dialog.ShowDialog()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }",
  ]
    .filter(Boolean)
    .join("; ");

  const result = await spawnProcess("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ]);

  return String(result.stdout || "").trim();
}

async function showDirectoryPicker(request) {
  const currentPath = String(request.currentPath || "").trim();

  const command = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = '${escapePowerShellString(request.title)}'`,
    "$dialog.ShowNewFolderButton = $true",
    currentPath && path.isAbsolute(currentPath)
      ? `$dialog.SelectedPath = '${escapePowerShellString(currentPath)}'`
      : "",
    "$result = $dialog.ShowDialog()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  ]
    .filter(Boolean)
    .join("; ");

  const result = await spawnProcess("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ]);

  return String(result.stdout || "").trim();
}

async function moveFileToDirectory(request) {
  await fs.promises.mkdir(request.targetDirectory, { recursive: true });
  const destinationPath = await resolveUniquePath(
    path.join(request.targetDirectory, request.targetFilename),
  );

  try {
    await fs.promises.rename(request.sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw new Error("The selected save folder could not be used.");
    }

    await fs.promises.copyFile(request.sourcePath, destinationPath);
    await fs.promises.unlink(request.sourcePath);
  }

  return destinationPath;
}

async function resolveUniquePath(filePath) {
  const parsedPath = path.parse(filePath);
  let candidatePath = filePath;
  let counter = 1;

  while (await fileExists(candidatePath)) {
    candidatePath = path.join(
      parsedPath.dir,
      `${parsedPath.name} (${counter})${parsedPath.ext}`,
    );
    counter += 1;
  }

  return candidatePath;
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

async function readTranscriptText(transcriptPath) {
  const raw = await fs.promises.readFile(transcriptPath, "utf8");
  return raw.replace(/^\uFEFF/, "");
}

function formatTranscriptForAnkiField(transcriptText, translatedText = "") {
  const normalizedTranscript = normalizeMultilineText(transcriptText);
  const normalizedTranslation = normalizeMultilineText(translatedText);

  if (!normalizedTranscript) {
    return "";
  }

  if (!normalizedTranslation) {
    return `<div style="white-space: pre-wrap;">${escapeHtml(normalizedTranscript)}</div>`;
  }

  return [
    `<div style="font-weight: 700; margin-bottom: 6px;">Transcript</div>`,
    `<div style="white-space: pre-wrap;">${escapeHtml(normalizedTranscript)}</div>`,
    `<div style="font-weight: 700; margin-top: 12px; margin-bottom: 6px;">Translation</div>`,
    `<div style="white-space: pre-wrap;">${escapeHtml(normalizedTranslation)}</div>`,
  ].join("");
}

function normalizeMultilineText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapePowerShellString(value) {
  return String(value || "").replace(/'/g, "''");
}

function sanitizeName(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
}

function stripTxtExtension(filePath) {
  return String(filePath || "").replace(/\.txt$/i, "");
}

async function assertFileExists(filePath, errorMessage) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch (error) {
    throw new Error(errorMessage);
  }
}

function spawnProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Could not start whisper-cli.\n${error.message || "Unknown process error."}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          stderr.trim() ||
            stdout.trim() ||
            `whisper.cpp exited with code ${code}.`,
        ),
      );
    });
  });
}

// The popup cannot call AnkiConnect directly: AnkiConnect rejects requests whose
// Origin is not in its webCorsOriginList, and a chrome-extension:// origin is not
// there by default. The native host has no such restriction, so deck listing —
// like every other Anki call — goes through here.
async function listAnkiDecks(message) {
  const anki = normalizeAnkiConfig({ ...message?.anki, enabled: true });
  const decks = await invokeAnki(anki.connectUrl, "deckNames", {});

  if (!Array.isArray(decks)) {
    throw new Error("Anki did not return a deck list.");
  }

  return {
    decks: decks
      .map((deck) => String(deck || "").trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
  };
}

// Anki's own catalog, so the popup can offer real note types and real field names
// instead of asking the user to type them. Like the deck list, this has to go
// through the native host: AnkiConnect's CORS allow-list rejects chrome-extension
// origins outright.
async function listAnkiNoteTypes(message) {
  const anki = normalizeAnkiConfig({ ...message?.anki, enabled: true });
  const noteTypes = await invokeAnki(anki.connectUrl, "modelNames", {});

  if (!Array.isArray(noteTypes)) {
    throw new Error("Anki did not return a note type list.");
  }

  return {
    noteTypes: noteTypes
      .map((noteType) => String(noteType || "").trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
  };
}

async function listAnkiFields(message) {
  const anki = normalizeAnkiConfig({ ...message?.anki, enabled: true });
  const noteType = String(message?.noteType || anki.modelName || "").trim();

  if (!noteType) {
    throw new Error("A note type is required to list its fields.");
  }

  const fields = await invokeAnki(anki.connectUrl, "modelFieldNames", {
    modelName: noteType,
  });

  if (!Array.isArray(fields)) {
    throw new Error(`Anki did not return the fields for "${noteType}".`);
  }

  return {
    noteType,
    fields: fields.map((field) => String(field || "").trim()).filter(Boolean),
  };
}

function invokeAnki(connectUrl, action, params = {}) {
  const parsedUrl = new URL(connectUrl);
  const body = JSON.stringify({
    action,
    version: ANKI_CONNECT_VERSION,
    params,
  });

  return invokeAnkiOnce(parsedUrl, body).catch((error) => {
    if (!isRetryableAnkiError(error)) {
      throw error;
    }

    return invokeAnkiOnce(parsedUrl, body);
  });
}

function invokeAnkiOnce(parsedUrl, body) {
  const transport = parsedUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Connection": "close",
        },
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

            if (payload?.error) {
              reject(new Error(payload.error));
              return;
            }

            resolve(payload?.result);
          } catch (error) {
            reject(new Error("AnkiConnect returned invalid JSON."));
          }
        });
      },
    );

    request.on("error", (error) => {
      reject(error);
    });

    request.write(body);
    request.end();
  });
}

function isAnkiUnavailableError(error) {
  const message = String(error?.message || error || "");

  return (
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("socket hang up") ||
    message.includes("connect ECONN")
  );
}

function isRetryableAnkiError(error) {
  const message = String(error?.message || error || "");

  return (
    message.includes("ECONNRESET") ||
    message.includes("socket hang up")
  );
}

// Client half of the translation bridge (see translation/BRIDGE.md). The `/v1`
// HTTP contract is unchanged — this process simply became the thing that speaks
// it, instead of the service worker. The worker now only does the part that
// genuinely needs a browser: driving the provider page.
const TranslationBridgeWorker = (() => {
  const PROTOCOL = "1";
  const LONG_POLL_SECONDS = 25;
  const LONG_POLL_TIMEOUT_MS = 40000;
  const HEALTH_TIMEOUT_MS = 5000;
  const RESULT_TIMEOUT_MS = 15000;
  const HEARTBEAT_MS = 20000;
  const MIN_RECONNECT_MS = 1000;
  const MAX_RECONNECT_MS = 30000;
  // How long the extension gets to translate one job before we give it back to
  // the host as failed. Stays under the desktop app's own 90s job timeout.
  const JOB_TIMEOUT_MS = 75000;

  let running = false;
  let endpoint = "";
  let generation = 0;
  let reconnectFailures = 0;
  let heartbeatTimer = null;
  const inFlightJobs = new Map();

  function isRunning() {
    return running;
  }

  function handle(message) {
    if (message.type === "bridge-start") {
      start(message.endpoint);
      return;
    }

    if (message.type === "bridge-stop") {
      stop();
      return;
    }

    if (message.type === "bridge-result" || message.type === "bridge-fail") {
      const pending = inFlightJobs.get(message.id);
      if (!pending) {
        // The job already timed out, or the worker restarted and is answering a
        // job from a previous connection. Either way the host has moved on.
        return;
      }

      inFlightJobs.delete(message.id);
      clearTimeout(pending.timer);

      if (message.type === "bridge-result") {
        pending.resolve({ ok: true, text: String(message.translatedText || "") });
      } else {
        pending.resolve({
          ok: false,
          error: String(message.error || "The extension could not translate this text."),
        });
      }
    }
  }

  function start(nextEndpoint) {
    const sanitized = sanitizeEndpoint(nextEndpoint);

    if (running && sanitized === endpoint) {
      return;
    }

    stop();
    endpoint = sanitized;
    running = true;
    generation += 1;
    reconnectFailures = 0;

    startHeartbeat();
    void loop(generation);
  }

  function stop() {
    running = false;
    generation += 1;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    for (const pending of inFlightJobs.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "The translation bridge stopped." });
    }
    inFlightJobs.clear();
  }

  // Every message we push resets the service worker's idle timer, so this is
  // both a liveness signal for the popup and a belt-and-braces keepalive.
  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      writeNativeMessage({ type: "bridge-heartbeat" });
    }, HEARTBEAT_MS);

    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }
  }

  async function loop(token) {
    while (running && token === generation) {
      try {
        const health = await probeHealth();
        reconnectFailures = 0;
        postStatus({ connected: true, version: health.version, lastError: "" });

        while (running && token === generation) {
          const job = await claimNextJob();
          if (!running || token !== generation) {
            return;
          }
          if (job) {
            await runJob(job);
          }
        }
      } catch (error) {
        if (!running || token !== generation) {
          return;
        }

        reconnectFailures += 1;
        postStatus({
          connected: false,
          version: "",
          lastError: describeError(error),
        });

        await sleep(reconnectDelayMs(reconnectFailures));
      }
    }
  }

  // Exponential backoff with jitter, so a host that is down does not get probed
  // every three seconds forever.
  function reconnectDelayMs(failures) {
    const capped = Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * 2 ** (failures - 1));
    return Math.round(capped / 2 + Math.random() * (capped / 2));
  }

  async function probeHealth() {
    const response = await request("/v1/health", { timeoutMs: HEALTH_TIMEOUT_MS });

    if (response.status !== 200) {
      throw new Error(
        `${endpoint} is in use by another program (status ${response.status}). The Wonder of U app is not listening there.`,
      );
    }

    const payload = parseJson(response.body);
    const protocol = String(payload?.protocol || "");

    if (protocol !== PROTOCOL) {
      throw new Error(
        protocol
          ? `${endpoint} speaks bridge protocol ${protocol}, but this extension needs ${PROTOCOL}.`
          : `${endpoint} answered, but it is not a Wonder of U bridge host.`,
      );
    }

    return { version: String(payload?.version || "") };
  }

  async function claimNextJob() {
    const response = await request(
      `/v1/translation/next?wait=${LONG_POLL_SECONDS}`,
      { timeoutMs: LONG_POLL_TIMEOUT_MS },
    );

    if (response.status === 204) {
      return null;
    }

    if (response.status !== 200) {
      throw new Error(`Bridge host returned status ${response.status}.`);
    }

    const job = parseJson(response.body);
    if (!job?.id || typeof job.sourceText !== "string") {
      return null;
    }

    return job;
  }

  // Hands the job to the extension and waits for it to come back. A worker that
  // is torn down mid-job never answers, so the timeout is what stops the host
  // from waiting out its full 90 seconds for a result that is never coming.
  function awaitExtension(job) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        inFlightJobs.delete(job.id);
        resolve({
          ok: false,
          error: "The extension did not return a translation in time.",
        });
      }, JOB_TIMEOUT_MS);

      if (typeof timer.unref === "function") {
        timer.unref();
      }

      inFlightJobs.set(job.id, { resolve, timer });
      writeNativeMessage({ type: "bridge-job", job });
    });
  }

  async function runJob(job) {
    const outcome = await awaitExtension(job);

    if (outcome.ok && outcome.text.trim()) {
      await reportResult(`/v1/translation/jobs/${encodeURIComponent(job.id)}/complete`, {
        translatedText: outcome.text,
      });
      return;
    }

    await reportResult(`/v1/translation/jobs/${encodeURIComponent(job.id)}/fail`, {
      error: outcome.error || "The provider returned no translation.",
    });
  }

  // A finished translation is expensive to produce — never drop it because a
  // single POST blipped. Retry once, and surface the failure rather than
  // pretending the post succeeded.
  async function reportResult(path, body) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await request(path, {
          method: "POST",
          body: JSON.stringify(body),
          timeoutMs: RESULT_TIMEOUT_MS,
        });

        if (response.status >= 200 && response.status < 300) {
          return;
        }

        if (attempt === 1) {
          postStatus({
            connected: false,
            version: "",
            lastError: `The app rejected a translation result (status ${response.status}).`,
          });
          return;
        }
      } catch (error) {
        if (attempt === 1) {
          postStatus({
            connected: false,
            version: "",
            lastError: describeError(error),
          });
          return;
        }
      }

      await sleep(MIN_RECONNECT_MS);
    }
  }

  function postStatus(status) {
    writeNativeMessage({
      type: "bridge-status",
      endpoint,
      ...status,
    });
  }

  function request(requestPath, { method = "GET", body = null, timeoutMs } = {}) {
    const parsedUrl = new URL(`${endpoint}${requestPath}`);

    return new Promise((resolve, reject) => {
      const headers = { Accept: "application/json" };

      if (body !== null) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(body);
      }

      const clientRequest = http.request(
        {
          protocol: parsedUrl.protocol,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method,
          headers,
        },
        (response) => {
          const chunks = [];

          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode || 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );

      clientRequest.setTimeout(timeoutMs, () => {
        clientRequest.destroy(
          new Error("The Wonder of U app did not respond in time."),
        );
      });

      clientRequest.on("error", (error) => reject(error));

      if (body !== null) {
        clientRequest.write(body);
      }

      clientRequest.end();
    });
  }

  function sanitizeEndpoint(value) {
    const fallback = "http://127.0.0.1:8791";

    try {
      const parsed = new URL(String(value || fallback));

      if (!LOCALHOST_HOSTS.has(parsed.hostname) || !parsed.port) {
        return fallback;
      }

      return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
    } catch {
      return fallback;
    }
  }

  function parseJson(body) {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  function describeError(error) {
    const message = String(error?.message || error || "");

    if (message.includes("ECONNREFUSED")) {
      return "The Wonder of U app is not running.";
    }

    return message || "The bridge host is unreachable.";
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });
  }

  return { handle, isRunning, stop, reconnectDelayMs, sanitizeEndpoint };
})();

// Reads the 4-byte-length framing continuously, so one stdin stream can carry
// many messages (a `connectNative` port) as well as a single one (`sendNativeMessage`).
// Chrome may split or coalesce writes, so a partial frame is buffered until the
// rest arrives, and a single chunk may contain several whole messages.
function startNativeMessageStream({ onMessage, onEnd, onError }) {
  let buffer = Buffer.alloc(0);

  const drainMessages = () => {
    for (;;) {
      if (buffer.length < 4) {
        return;
      }

      const messageLength = buffer.readUInt32LE(0);
      if (buffer.length < 4 + messageLength) {
        return;
      }

      const messageBuffer = buffer.subarray(4, 4 + messageLength);
      buffer = buffer.subarray(4 + messageLength);

      let message = null;

      try {
        message = JSON.parse(messageBuffer.toString("utf8"));
      } catch (error) {
        onError(new Error("Native host received a malformed message."));
        return;
      }

      onMessage(message);
    }
  };

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    drainMessages();
  });
  process.stdin.on("end", () => onEnd());
  process.stdin.on("error", (error) => onError(error));
  process.stdin.resume();
}

function writeNativeMessage(payload) {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);

  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}
