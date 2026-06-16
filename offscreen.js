let mediaRecorder = null;
let currentStream = null;
let monitorContext = null;
let monitorSource = null;
let chunks = [];
let recordingStartedAt = null;
let currentFormat = DEFAULT_FORMAT;
let transcriptionRequested = false;
let hasReportedError = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  handleOffscreenMessage(message)
    .then((response) => sendResponse(response))
    .catch(async (error) => {
      console.error("Offscreen handling failed:", error);
      if (
        message?.type === "start-recording" ||
        message?.type === "stop-recording"
      ) {
        await reportRecordingError(error);
      }
      sendResponse({
        ok: false,
        error: error.message || "Unexpected offscreen error.",
      });
    });

  return true;
});

async function handleOffscreenMessage(message) {
  if (message.type === "ping") {
    return { ok: true };
  }

  if (message.type === "start-recording") {
    await startRecording(
      message.streamId,
      message.format,
      message.transcriptionEnabled
    );
    return { ok: true };
  }

  if (message.type === "stop-recording") {
    await stopRecording();
    return { ok: true };
  }

  if (message.type === "record-av-test") {
    return runAvCaptureTest(message);
  }

  return { ok: false, error: "Unknown offscreen command." };
}

async function startRecording(streamId, format, shouldTranscribe) {
  if (mediaRecorder?.state === "recording") {
    return;
  }

  if (!streamId) {
    throw new Error("No tab stream ID was provided.");
  }

  chunks = [];
  currentFormat =
    format === "mp3" || format === "wav" ? format : DEFAULT_FORMAT;
  transcriptionRequested = Boolean(shouldTranscribe);
  recordingStartedAt = Date.now();
  hasReportedError = false;

  currentStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  monitorContext = new AudioContext();
  await monitorContext.resume();

  monitorSource = monitorContext.createMediaStreamSource(currentStream);
  monitorSource.connect(monitorContext.destination);

  mediaRecorder = new MediaRecorder(currentStream);
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  mediaRecorder.onerror = async (event) => {
    await reportRecordingError(
      event.error || new Error("MediaRecorder failed during capture.")
    );
  };

  mediaRecorder.start(1000);

  notifyBackground({
    type: "recording-started",
    startedAt: recordingStartedAt,
  });
}

async function stopRecording() {
  if (!mediaRecorder) {
    return;
  }

  await new Promise((resolve, reject) => {
    const activeRecorder = mediaRecorder;

    activeRecorder.onstop = async () => {
      try {
        const webmBlob = new Blob(chunks, {
          type: activeRecorder.mimeType || "audio/webm",
        });

        const result = await buildOutputPayload(webmBlob);
        const durationMs = recordingStartedAt
          ? Math.max(0, Date.now() - recordingStartedAt)
          : 0;

        await cleanup();

        await notifyBackground({
          type: "recording-complete",
          durationMs,
          ...result,
        });

        resolve();
      } catch (error) {
        reject(error);
      }
    };

    activeRecorder.stop();
  });
}

async function buildOutputPayload(webmBlob) {
  let primaryBlob = webmBlob;
  let extension = "webm";

  if (currentFormat === "mp3") {
    primaryBlob = await convertToMP3(webmBlob);
    extension = "mp3";
  }

  if (currentFormat === "wav") {
    primaryBlob = await convertToWav(webmBlob);
    extension = "wav";
  }

  const primaryBlobId = await saveRecordingBlob(primaryBlob);
  const payload = {
    blobId: primaryBlobId,
    extension,
    transcriptionRequested,
    transcriptionBlobId: null,
  };

  if (!transcriptionRequested) {
    return payload;
  }

  if (extension === "wav") {
    return payload;
  }

  const transcriptionBlob = await convertToWav(webmBlob);
  payload.transcriptionBlobId = await saveRecordingBlob(transcriptionBlob);

  return payload;
}

async function cleanup() {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
  }

  if (monitorSource) {
    monitorSource.disconnect();
  }

  if (monitorContext && monitorContext.state !== "closed") {
    await monitorContext.close();
  }

  mediaRecorder = null;
  currentStream = null;
  monitorContext = null;
  monitorSource = null;
  chunks = [];
  recordingStartedAt = null;
  transcriptionRequested = false;
}

async function runAvCaptureTest(message) {
  if (mediaRecorder?.state === "recording") {
    throw new Error("The main recorder is already active.");
  }

  if (!message.streamId) {
    throw new Error("No tab stream ID was provided for the A/V test.");
  }

  const durationMs = sanitizeTestDuration(message.durationMs);
  const mimeType = selectVideoMimeType(message.mimeType);
  const chunks = [];
  let testStream = null;
  let testMonitorContext = null;
  let testMonitorSource = null;
  let testRecorder = null;
  let startedAt = 0;

  try {
    testStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      },
    });

    testMonitorContext = new AudioContext();
    await testMonitorContext.resume();
    testMonitorSource = testMonitorContext.createMediaStreamSource(testStream);
    testMonitorSource.connect(testMonitorContext.destination);

    testRecorder = new MediaRecorder(testStream, {
      mimeType,
      videoBitsPerSecond: sanitizeTestBitrate(
        message.videoBitsPerSecond,
        12000000,
      ),
      audioBitsPerSecond: sanitizeTestBitrate(
        message.audioBitsPerSecond,
        320000,
      ),
    });

    testRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    startedAt = Date.now();

    await new Promise((resolve, reject) => {
      testRecorder.onerror = (event) => {
        reject(
          event.error || new Error("MediaRecorder failed during A/V test."),
        );
      };

      testRecorder.onstop = resolve;
      testRecorder.start(1000);

      setTimeout(() => {
        if (testRecorder?.state === "recording") {
          testRecorder.stop();
        }
      }, durationMs);
    });

    const blob = new Blob(chunks, {
      type: testRecorder.mimeType || mimeType,
    });

    if (!blob.size) {
      throw new Error("The A/V test did not capture any media data.");
    }

    const blobId = await saveRecordingBlob(blob);

    return {
      ok: true,
      blobId,
      extension: "webm",
      mimeType: blob.type || mimeType,
      sizeBytes: blob.size,
      durationMs: Date.now() - startedAt,
      actualVideoBitsPerSecond: testRecorder.videoBitsPerSecond,
      actualAudioBitsPerSecond: testRecorder.audioBitsPerSecond,
      trackSettings: testStream.getTracks().map((track) => ({
        kind: track.kind,
        label: track.label,
        settings:
          typeof track.getSettings === "function" ? track.getSettings() : {},
      })),
    };
  } finally {
    if (testStream) {
      testStream.getTracks().forEach((track) => track.stop());
    }

    if (testMonitorSource) {
      testMonitorSource.disconnect();
    }

    if (testMonitorContext && testMonitorContext.state !== "closed") {
      await testMonitorContext.close();
    }
  }
}

function selectVideoMimeType(requestedMimeType) {
  const candidates = [
    requestedMimeType,
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ].filter(Boolean);

  return (
    candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ||
    "video/webm"
  );
}

function sanitizeTestDuration(value) {
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 5000;
  }

  return Math.min(Math.max(durationMs, 1000), 30000);
}

function sanitizeTestBitrate(value, fallback) {
  const bitrate = Number(value);
  return Number.isFinite(bitrate) && bitrate > 0 ? bitrate : fallback;
}

async function reportRecordingError(error) {
  if (hasReportedError) {
    return;
  }

  hasReportedError = true;
  await cleanup();

  notifyBackground({
    type: "recording-error",
    message: error?.message || "Recording failed.",
  });
}

function notifyBackground(message) {
  return chrome.runtime.sendMessage(message).catch((error) => {
    const errorMessage = String(error?.message || error || "");

    if (
      errorMessage.includes("Receiving end does not exist") ||
      errorMessage.includes("message channel closed")
    ) {
      return null;
    }

    console.warn("Background notification failed:", error);
    return null;
  });
}
