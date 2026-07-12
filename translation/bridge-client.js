(function initializeTranslationBridgeClient(globalScope) {
  "use strict";

  // Client half of the Wonder of U translation bridge. In App-Support mode the
  // extension connects OUT to a consumer that hosts the loopback server (the
  // desktop app, or the Anki add-on). See translation/BRIDGE.md for the
  // contract. The extension never hosts a server; it long-polls for jobs,
  // performs provider-specific browser automation, and posts results back.

  const PROTOCOL_VERSION = "1";
  const HEALTH_TIMEOUT_MS = 4000;
  const LONG_POLL_WAIT_SECONDS = 25;
  const LONG_POLL_TIMEOUT_MS = 35000;
  const RESULT_TIMEOUT_MS = 10000;
  const RECONNECT_DELAY_MS = 3000;

  let running = false;
  let loopToken = 0;
  let endpoint = DEFAULT_BRIDGE_ENDPOINT;

  const status = {
    running: false,
    connected: false,
    endpoint,
    version: "",
    lastError: "",
    lastJobAt: null,
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function configure(options = {}) {
    if (options.endpoint) {
      endpoint = sanitizeBridgeEndpoint(options.endpoint);
      status.endpoint = endpoint;
    }
  }

  function getStatus() {
    return { ...status, endpoint };
  }

  async function fetchWithTimeout(path, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(`${endpoint}${path}`, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // A loopback port can be held by anything — Anki sits on 8765/8766 right next
  // to us. Confirm whoever answered actually speaks our contract, so a stranger
  // on the port reads as "not the app" rather than a bare, puzzling HTTP status.
  async function probeHealth() {
    const response = await fetchWithTimeout("/v1/health", { method: "GET" });
    if (!response.ok) {
      throw new Error(
        `${endpoint} is in use by another program (status ${response.status}). The Wonder of U app is not listening there.`,
      );
    }

    const payload = await response.json().catch(() => ({}));
    const protocol = String(payload?.protocol || "");

    if (protocol !== PROTOCOL_VERSION) {
      throw new Error(
        protocol
          ? `${endpoint} speaks bridge protocol ${protocol}, but this extension needs ${PROTOCOL_VERSION}.`
          : `${endpoint} answered, but it is not a Wonder of U bridge host.`,
      );
    }

    return {
      version: String(payload?.version || ""),
      protocol,
    };
  }

  async function claimNextJob() {
    const response = await fetchWithTimeout(
      `/v1/translation/next?wait=${LONG_POLL_WAIT_SECONDS}`,
      { method: "GET" },
      LONG_POLL_TIMEOUT_MS,
    );

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Bridge host returned status ${response.status}.`);
    }

    const job = await response.json().catch(() => null);
    if (!job?.id || typeof job.sourceText !== "string") {
      return null;
    }

    return job;
  }

  async function completeJob(jobId, translatedText) {
    await fetchWithTimeout(
      `/v1/translation/jobs/${encodeURIComponent(jobId)}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ translatedText: String(translatedText || "") }),
      },
      RESULT_TIMEOUT_MS,
    );
  }

  async function failJob(jobId, errorText) {
    await fetchWithTimeout(
      `/v1/translation/jobs/${encodeURIComponent(jobId)}/fail`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: String(errorText || "Translation failed.") }),
      },
      RESULT_TIMEOUT_MS,
    ).catch(() => {});
  }

  async function handleJob(job) {
    let providerId = String(job.provider || "").trim();
    if (!providerId) {
      const settings = await getTranslationSettings();
      providerId = settings.provider;
    }

    try {
      const result = await globalScope.TranslationService.capture(
        providerId,
        job.sourceText,
      );

      if (result.translatedText) {
        await completeJob(job.id, result.translatedText);
        status.lastJobAt = Date.now();
      } else {
        await failJob(
          job.id,
          result.errorText || "The provider returned no translation.",
        );
      }
    } catch (error) {
      await failJob(job.id, error?.message || "Translation job failed.");
    }
  }

  async function loop(token) {
    while (running && token === loopToken) {
      try {
        const health = await probeHealth();
        status.connected = true;
        status.version = health.version;
        status.lastError = "";

        while (running && token === loopToken) {
          const job = await claimNextJob();
          if (!running || token !== loopToken) {
            return;
          }
          if (job) {
            await handleJob(job);
          }
        }
      } catch (error) {
        status.connected = false;
        status.lastError = String(
          error?.message || error || "Bridge host is unreachable.",
        );
        if (!running || token !== loopToken) {
          return;
        }
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  function start(options = {}) {
    configure(options);
    if (running) {
      return;
    }

    running = true;
    status.running = true;
    loopToken += 1;
    loop(loopToken);
  }

  function stop() {
    running = false;
    loopToken += 1;
    status.running = false;
    status.connected = false;
  }

  // One-shot health probe for the popup, independent of the running loop.
  async function checkHealth(options = {}) {
    configure(options);
    try {
      const health = await probeHealth();
      status.connected = true;
      status.version = health.version;
      status.lastError = "";
    } catch (error) {
      status.connected = false;
      status.lastError = String(
        error?.message || error || "Bridge host is unreachable.",
      );
    }

    return getStatus();
  }

  globalScope.TranslationBridgeClient = Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    configure,
    start,
    stop,
    getStatus,
    checkHealth,
  });
})(self);
