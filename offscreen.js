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

  if (message.type === "analyze-audio") {
    // Run in the background and PUSH the result — the service worker may be torn
    // down during the ~30s capture, so we can't rely on returning it as the reply.
    // The offscreen doc stays alive while actively capturing.
    startAudioAnalysis(message);
    return { ok: true };
  }

  return { ok: false, error: "Unknown offscreen command." };
}

// Captures the tab's audio for a short window and PUSHES it back as a 16 kHz mono
// WAV (via the service worker → native host) for transcription — the input to
// automatic subtitle sync. Analysis-only: no MediaRecorder, no file on disk here.
// Reuses the same tab-capture + AudioContext-monitor path as recording, so the tab
// stays audible while we listen. The tabId is carried through so the SW can route
// the result even if it was torn down and revived during the capture.
async function startAudioAnalysis(message) {
  const tabId = message.tabId;

  if (mediaRecorder?.state === "recording") {
    notifyBackground({
      type: "autosync-complete",
      tabId,
      error: "The recorder is already active.",
    });
    return;
  }
  if (!message.streamId) {
    notifyBackground({
      type: "autosync-complete",
      tabId,
      error: "No tab stream ID was provided for audio analysis.",
    });
    return;
  }

  const totalMs = Math.min(
    Math.max(Number(message.durationMs) || 30000, 5000),
    60000,
  );

  let stream = null;
  let context = null;
  let source = null;
  let capture = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      },
      video: false,
    });

    context = new AudioContext();
    await context.resume();
    source = context.createMediaStreamSource(stream);
    source.connect(context.destination); // keep the tab audible while listening

    // Stream the raw PCM out via an AudioWorklet so the VAD gets clean, contiguous
    // samples (an AnalyserNode poll would leave gaps).
    await context.audioWorklet.addModule(
      chrome.runtime.getURL("capture-worklet.js"),
    );
    capture = new AudioWorkletNode(context, "wonder-capture");
    const chunks = [];
    let sampleCount = 0;
    let anchorSent = false;
    capture.port.onmessage = (event) => {
      chunks.push(event.data);
      sampleCount += event.data.length;
      // Anchor on the FIRST real audio sample, not at setup: getUserMedia +
      // AudioContext + worklet warm-up delay the stream ~0.5–1s, and anchoring at
      // setup biases the whole offset by that much. The content script reads
      // video.currentTime when this arrives, so it must mark actual audio-start.
      if (!anchorSent) {
        anchorSent = true;
        notifyBackground({ type: "autosync-started", tabId });
      }
    };
    source.connect(capture);
    // The worklet outputs silence; connecting it to the destination guarantees the
    // graph pulls it (so process() runs) without adding any audible signal.
    capture.connect(context.destination);

    await new Promise((resolve) => setTimeout(resolve, totalMs));

    const pcm = new Float32Array(sampleCount);
    let position = 0;
    for (const chunk of chunks) {
      pcm.set(chunk, position);
      position += chunk.length;
    }

    // Encode the captured audio as a 16 kHz mono WAV and hand it to the background,
    // which routes it to the native host for transcription. The overlay then matches
    // the transcribed lines against the loaded subtitles to compute the offset.
    const wavBase64 = await encodeClipToWavBase64(pcm, context.sampleRate);
    notifyBackground({ type: "autosync-clip", tabId, wavBase64 });
  } catch (error) {
    notifyBackground({
      type: "autosync-complete",
      tabId,
      error: error?.message || "Auto-sync analysis failed.",
    });
  } finally {
    if (capture) {
      capture.port.onmessage = null;
      capture.disconnect();
    }
    if (source) {
      source.disconnect();
    }
    if (context && context.state !== "closed") {
      await context.close();
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
  }
}

// Downmixed already (the worklet emits channel 0), so this only rate-converts the
// captured PCM to the 16 kHz Whisper expects. Uses an OfflineAudioContext for a
// clean resample rather than naive decimation.
async function resampleTo16kMono(pcm, inputRate) {
  const targetRate = 16000;
  if (!inputRate || inputRate === targetRate || pcm.length === 0) {
    return pcm;
  }
  const frames = Math.max(
    1,
    Math.round((pcm.length * targetRate) / inputRate),
  );
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const buffer = offline.createBuffer(1, pcm.length, inputRate);
  buffer.copyToChannel(pcm, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// Minimal 16-bit PCM WAV encoder (mono). whisper-cli reads a plain WAV off disk.
function encodeWav16(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    offset += 2;
  }
  return buffer;
}

// Base64 without stack-overflowing on ~0.5 MB (String.fromCharCode(...bytes) blows
// the call stack); FileReader turns the Blob into a data URL we strip the prefix off.
function arrayBufferToBase64(buffer) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("Could not encode the captured audio clip."));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(new Blob([buffer], { type: "audio/wav" }));
  });
}

async function encodeClipToWavBase64(pcm, inputRate) {
  const resampled = await resampleTo16kMono(pcm, inputRate);
  return arrayBufferToBase64(encodeWav16(resampled, 16000));
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
