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

main();

async function main() {
  try {
    const message = await readNativeMessage();
    const payload = await handleNativeMessage(message);
    writeNativeMessage({
      ok: true,
      ...payload,
    });
  } catch (error) {
    writeNativeMessage({
      ok: false,
      error: error?.message || "Native host failed.",
    });
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

  return {
    enabled: Boolean(anki?.enabled),
    connectUrl: parsedUrl.toString(),
    deckName: String(anki?.deckName || "Audio Immersion").trim() || "Audio Immersion",
    modelName: String(anki?.modelName || "Basic").trim() || "Basic",
    frontField: String(anki?.frontField || "Front").trim() || "Front",
    backField: String(anki?.backField || "Back").trim() || "Back",
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
    frontField: job.anki.frontField,
    backField: job.anki.backField,
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

    const transcriptHtml =
      job.transcriptHtml || formatTranscriptForAnkiField(job.transcriptText);

    const noteId = await invokeAnki(job.connectUrl, "addNote", {
      note: {
        deckName: job.deckName,
        modelName: job.modelName,
        fields: {
          [job.frontField]: `[sound:${job.mediaFilename}]`,
          [job.backField]: transcriptHtml || "(Transcript unavailable)",
        },
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

function readNativeMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    let settled = false;

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
    };

    const tryResolveMessage = () => {
      if (settled || totalLength < 4) {
        return;
      }

      try {
        const buffer = Buffer.concat(chunks, totalLength);
        const messageLength = buffer.readUInt32LE(0);

        if (totalLength < 4 + messageLength) {
          return;
        }

        const messageBuffer = buffer.subarray(4, 4 + messageLength);
        settled = true;
        cleanup();
        resolve(JSON.parse(messageBuffer.toString("utf8")));
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    };

    const onData = (chunk) => {
      chunks.push(Buffer.from(chunk));
      totalLength += chunk.length;
      tryResolveMessage();
    };

    const onEnd = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(
        new Error("Native host input stream ended before a full message arrived."),
      );
    };

    const onError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}

function writeNativeMessage(payload) {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);

  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}
