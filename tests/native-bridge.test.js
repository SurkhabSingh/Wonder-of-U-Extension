"use strict";

// Spawns the real native host and drives it over real stdio framing against a
// real loopback /v1 server. The bridge is the piece that has to survive Chrome
// tearing the service worker down, so it is tested as a process, not as a mock.

const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const hostPath = path.join(projectRoot, "native-host.js");

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Mirrors the host's own framing, so a split or coalesced write is decoded the
// same way Chrome would decode it.
function createMessageReader(onMessage) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      if (buffer.length < 4) {
        return;
      }

      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) {
        return;
      }

      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      onMessage(JSON.parse(body.toString("utf8")));
    }
  };
}

function startBridgeHostServer() {
  const received = { completed: [], failed: [] };
  let pendingJob = null;
  let waiter = null;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (url.pathname === "/v1/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          protocol: "1",
          version: "test-host",
          name: "wonder-of-u-desktop",
        }),
      );
      return;
    }

    if (url.pathname === "/v1/translation/next") {
      const deliver = () => {
        if (!pendingJob) {
          response.writeHead(204).end();
          return;
        }

        const job = pendingJob;
        pendingJob = null;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(job));
      };

      if (pendingJob) {
        deliver();
        return;
      }

      // Hold the poll open, exactly as the desktop app does.
      waiter = deliver;
      return;
    }

    const completeMatch = url.pathname.match(
      /^\/v1\/translation\/jobs\/(.+)\/complete$/,
    );
    const failMatch = url.pathname.match(/^\/v1\/translation\/jobs\/(.+)\/fail$/);

    if (completeMatch || failMatch) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const id = decodeURIComponent((completeMatch || failMatch)[1]);

        if (completeMatch) {
          received.completed.push({ id, ...body });
        } else {
          received.failed.push({ id, ...body });
        }

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    response.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        received,
        endpoint: `http://127.0.0.1:${server.address().port}`,
        submit(job) {
          pendingJob = job;
          if (waiter) {
            const deliver = waiter;
            waiter = null;
            deliver();
          }
        },
      });
    });
  });
}

function startHost() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wonder-host-test-"));
  const child = spawn(process.execPath, [hostPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AUDIO_RECORDER_HOST_DATA_DIR: dataDir },
  });

  const listeners = [];
  const messages = [];

  child.stdout.on(
    "data",
    createMessageReader((message) => {
      messages.push(message);
      for (const listener of [...listeners]) {
        listener(message);
      }
    }),
  );

  return {
    child,
    send: (payload) => child.stdin.write(encodeMessage(payload)),
    messages,
    // Resolves with the first message matching `predicate`, including ones that
    // already arrived before this was called.
    waitFor(predicate, description) {
      const existing = messages.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
          reject(
            new Error(
              `Timed out waiting for ${description}. Saw: ${JSON.stringify(messages)}`,
            ),
          );
        }, 15000);

        const listener = (message) => {
          if (!predicate(message)) {
            return;
          }

          clearTimeout(timer);
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
          resolve(message);
        };

        listeners.push(listener);
      });
    },
    stop() {
      child.stdin.end();
      child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function testJobRoundTrip() {
  const host = await startBridgeHostServer();
  const worker = startHost();

  try {
    worker.send({ type: "bridge-start", endpoint: host.endpoint });

    const connected = await worker.waitFor(
      (message) => message.type === "bridge-status" && message.connected,
      "a connected bridge-status",
    );
    assert.equal(connected.version, "test-host");

    host.submit({
      id: "job-1",
      provider: "google-translate",
      sourceText: "hello",
      sourceLang: "en",
      targetLang: "ja",
    });

    const pushed = await worker.waitFor(
      (message) => message.type === "bridge-job",
      "a pushed bridge-job",
    );
    assert.equal(pushed.job.id, "job-1");
    assert.equal(pushed.job.sourceText, "hello");
    assert.equal(pushed.job.targetLang, "ja");

    worker.send({
      type: "bridge-result",
      id: "job-1",
      translatedText: "こんにちは",
    });

    await waitUntil(
      () => host.received.completed.length > 0,
      "the completion to reach the host",
    );
    assert.deepEqual(host.received.completed[0], {
      id: "job-1",
      translatedText: "こんにちは",
    });
  } finally {
    worker.stop();
    host.server.close();
  }
}

async function testExtensionFailureIsReported() {
  const host = await startBridgeHostServer();
  const worker = startHost();

  try {
    worker.send({ type: "bridge-start", endpoint: host.endpoint });
    await worker.waitFor(
      (message) => message.type === "bridge-status" && message.connected,
      "a connected bridge-status",
    );

    host.submit({
      id: "job-2",
      provider: "deepl",
      sourceText: "hello",
      sourceLang: "en",
      targetLang: "ja",
    });

    await worker.waitFor(
      (message) => message.type === "bridge-job",
      "a pushed bridge-job",
    );

    worker.send({
      type: "bridge-fail",
      id: "job-2",
      error: "DeepL permission is missing.",
    });

    await waitUntil(
      () => host.received.failed.length > 0,
      "the failure to reach the host",
    );
    assert.equal(host.received.failed[0].id, "job-2");
    assert.match(host.received.failed[0].error, /permission/i);
    assert.equal(
      host.received.completed.length,
      0,
      "a failed job must never be completed",
    );
  } finally {
    worker.stop();
    host.server.close();
  }
}

// A host that is not a Wonder of U bridge (Anki, say) must read as "not the app"
// rather than as a bare HTTP status, and must not be treated as connected.
async function testRejectsForeignHost() {
  const foreign = http.createServer((request, response) => {
    response.writeHead(404).end();
  });

  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const worker = startHost();

  try {
    worker.send({
      type: "bridge-start",
      endpoint: `http://127.0.0.1:${foreign.address().port}`,
    });

    const status = await worker.waitFor(
      (message) => message.type === "bridge-status" && !message.connected,
      "a disconnected bridge-status",
    );
    assert.match(status.lastError, /another program|not a Wonder of U/i);
  } finally {
    worker.stop();
    foreign.close();
  }
}

// The one-shot path (`sendNativeMessage`) must still work: the same process now
// serves a message loop, and an unknown request has to come back as an error
// rather than hang.
async function testOneShotRequestsStillWork() {
  const worker = startHost();

  try {
    worker.send({ type: "not-a-real-request" });

    const response = await worker.waitFor(
      (message) => message.ok === false,
      "a one-shot error response",
    );
    assert.match(response.error, /Unsupported native host request/i);
  } finally {
    worker.stop();
  }
}

// Chrome closes stdin when it disconnects the port. If the bridge worker keeps
// polling through that, the process never exits and every App-Support session
// leaks a node process.
async function testHostExitsWhenThePortCloses() {
  const host = await startBridgeHostServer();
  const worker = startHost();

  try {
    worker.send({ type: "bridge-start", endpoint: host.endpoint });
    await worker.waitFor(
      (message) => message.type === "bridge-status" && message.connected,
      "a connected bridge-status",
    );

    const exited = new Promise((resolve) => worker.child.once("exit", resolve));
    worker.child.stdin.end();

    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("the host did not exit after the port closed")),
        8000,
      ).unref(),
    );

    await Promise.race([exited, timeout]);
  } finally {
    worker.stop();
    host.server.close();
  }
}

function waitUntil(predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }

      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${description}.`));
        return;
      }

      setTimeout(tick, 25);
    };

    tick();
  });
}

async function run() {
  await testJobRoundTrip();
  await testExtensionFailureIsReported();
  await testRejectsForeignHost();
  await testOneShotRequestsStillWork();
  await testHostExitsWhenThePortCloses();

  console.log("Native bridge worker tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
