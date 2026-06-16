"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const calls = [];
const context = vm.createContext({
  chrome: {
    tabCapture: {
      getMediaStreamId: async (options) => {
        calls.push(["stream", options]);
        return "test-stream-id";
      },
    },
  },
});

context.self = context;

const source = fs.readFileSync(
  path.join(projectRoot, "capture/browser-tab-capture-provider.js"),
  "utf8",
);
vm.runInContext(source, context, {
  filename: "capture/browser-tab-capture-provider.js",
});

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function run() {
  const provider = context.BrowserTabCaptureProvider;
  const prepare = async () => {
    calls.push(["prepare"]);
  };
  const send = async (message) => {
    calls.push(["send", message]);
    return { ok: true, message };
  };

  const startResult = await provider.startAudioCapture({
    targetTabId: 42,
    format: "wav",
    transcriptionEnabled: true,
    prepare,
    send,
  });

  assert.equal(startResult.ok, true);
  assert.deepEqual(toPlain(calls.slice(0, 3)), [
    ["prepare"],
    ["stream", { targetTabId: 42 }],
    [
      "send",
      {
        type: "start-recording",
        streamId: "test-stream-id",
        format: "wav",
        transcriptionEnabled: true,
      },
    ],
  ]);

  calls.length = 0;
  const sampleResult = await provider.recordAvSample({
    targetTabId: 42,
    durationMs: 5000,
    videoBitsPerSecond: 16000000,
    audioBitsPerSecond: 510000,
    prepare,
    send,
  });

  assert.equal(sampleResult.ok, true);
  assert.deepEqual(toPlain(calls[2]), [
    "send",
    {
      type: "record-av-test",
      streamId: "test-stream-id",
      durationMs: 5000,
      videoBitsPerSecond: 16000000,
      audioBitsPerSecond: 510000,
    },
  ]);

  calls.length = 0;
  await provider.stopCapture({ send });
  assert.deepEqual(toPlain(calls), [["send", { type: "stop-recording" }]]);

  await assert.rejects(
    provider.startAudioCapture({
      targetTabId: null,
      prepare,
      send,
    }),
    /valid target tab/i,
  );

  console.log("Browser tab capture provider tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
