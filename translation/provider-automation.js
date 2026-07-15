(function initializeTranslationAutomation(globalScope) {
  "use strict";

  // Drives a provider website (Google Translate, DeepL) through DOM automation.
  //
  // The tab we drive is always hidden, and Chrome is hostile to hidden tabs: it
  // suspends requestAnimationFrame entirely, clamps timers to 1s (then to once a
  // minute after five minutes), and stops rendering altogether when the window is
  // minimized. There is no extension-accessible opt-out. So the automation is
  // built to lean on as little of that machinery as possible:
  //
  //   * navigate with the text and languages already in the URL, so the page
  //     translates on load and we never depend on typing or input debounce;
  //   * detect completion with a MutationObserver, which fires on DOM changes
  //     rather than on a clamped timer;
  //   * read `textContent`, not `innerText`, because `innerText` needs layout and
  //     layout is suspended in a minimized window.
  //
  // It is still best-effort by nature. Anything that must not fail belongs on an
  // HTTP provider (see DeepL's API-key path), not here.

  const DEFAULT_TIMING = Object.freeze({
    tabLoadTimeoutMs: 15000,
    pageTimeoutMs: 45000,
    // How long the translated output must stop changing before we read it. The
    // MutationObserver already fires on the last DOM change; this is the settle
    // margin on top. 800ms is a comfortable margin above a typical render while
    // shaving latency off every translation vs. the old 1200ms.
    stableWindowMs: 800,
    injectRetryDelayMs: 400,
    // Backstop only. The MutationObserver does the real work; this just gives the
    // stability window a tick to elapse on a page that has gone quiet.
    backstopIntervalMs: 250,
  });

  // Guards against a pathological transcript spawning hundreds of tabs.
  const MAX_CHUNKS = 24;
  const OWNED_TABS_KEY = "providerTabIds";

  function createBrowserTranslationProvider(providerConfig) {
    const config = normalizeConfig(providerConfig);

    async function capture(sourceText, options = {}) {
      const normalizedSource = String(sourceText || "").trim();

      if (!normalizedSource) {
        return createFailure(config, "The transcript was empty.");
      }

      const hasPermission = await chrome.permissions.contains({
        origins: [config.hostPermission],
      });

      if (!hasPermission) {
        return createFailure(config, `${config.label} permission is missing.`);
      }

      const sourceLang = normalizeLanguage(options.sourceLang, "auto");
      const targetLang = normalizeLanguage(options.targetLang, "en");

      // Provider pages silently truncate anything past their input cap, so a long
      // transcript has to be translated in pieces and reassembled.
      const chunks = splitIntoChunks(normalizedSource, config.maxChunkChars);

      if (chunks.length > MAX_CHUNKS) {
        return createFailure(
          config,
          `The transcript is too long for ${config.label} (${chunks.length} parts).`,
        );
      }

      const translatedChunks = [];

      // A multi-chunk transcript reuses one warm tab: the first chunk arrives via
      // the deep link (which is also what sets the languages), and the rest are
      // typed into the page that is already loaded. That turns N page loads into
      // one. The tab is still closed at the end of the job — a tab left hidden for
      // more than five minutes crosses Chrome's intensive-throttling and freezing
      // thresholds, so keeping one alive indefinitely trades a page load for a tab
      // that quietly stops responding.
      if (chunks.length > 1) {
        const shared = await translateChunksInOneTab(
          config,
          chunks,
          sourceLang,
          targetLang,
        );

        if (shared.ok) {
          translatedChunks.push(...shared.texts);
        }
      }

      // Either a single chunk, or the warm tab did not see it through. Fall back to
      // a fresh tab per chunk, which is the slower but sturdier path.
      if (!translatedChunks.length) {
        for (const chunk of chunks) {
          const outcome = await translateChunk(config, chunk, sourceLang, targetLang);

          if (!outcome.ok) {
            return createFailure(config, outcome.error);
          }

          translatedChunks.push(outcome.text);
        }
      }

      const translatedText = translatedChunks.join("\n").trim();

      if (!translatedText) {
        return createFailure(config, `${config.label} returned an empty result.`);
      }

      return {
        providerId: config.id,
        translatedText,
        errorText: "",
      };
    }

    return Object.freeze({
      id: config.id,
      config,
      capture,
    });
  }

  // Two attempts, and they are deliberately different.
  //
  // The first carries the text in the URL, so the page translates on load and we
  // never touch the input box. If the text is too long to survive a URL, the
  // provider says so and we type it instead — the languages still come from the
  // URL either way, which is how the target-language setting takes effect.
  //
  // The second is always a typing attempt in a brand-new tab. It covers a deep
  // link the provider quietly ignored, a redirect, or a consent interstitial. A
  // provider that fails both ways is genuinely unreachable, not merely unlucky.
  async function translateChunk(config, chunk, sourceLang, targetLang) {
    const deepLink = config.buildUrl({ sourceLang, targetLang, text: chunk });
    const bareLink = config.buildUrl({ sourceLang, targetLang, text: "" });

    const attempts = [
      { url: deepLink.url, typeText: !deepLink.includesText },
      { url: bareLink.url, typeText: true },
    ];

    let lastError = "";

    for (const attempt of attempts) {
      const outcome = await runAttempt(config, attempt, chunk);

      if (outcome.ok && String(outcome.text || "").trim()) {
        return { ok: true, text: String(outcome.text).trim() };
      }

      lastError = outcome.error || lastError;
    }

    return {
      ok: false,
      error: lastError || `${config.label} could not be read for this transcript.`,
    };
  }

  // Translates every chunk through a single tab. The first chunk rides the deep
  // link so the languages are set; each later chunk is typed into the same loaded
  // page, so the provider's app is booted once instead of once per chunk.
  async function translateChunksInOneTab(config, chunks, sourceLang, targetLang) {
    let tabId = null;
    const texts = [];

    try {
      await globalScope.ProviderVisibilityShim.sync();

      const first = config.buildUrl({ sourceLang, targetLang, text: chunks[0] });
      const tab = await openProviderTab(first.url);
      tabId = tab?.id ?? null;

      if (!tabId) {
        return { ok: false };
      }

      await rememberOwnedTab(tabId);

      for (let index = 0; index < chunks.length; index += 1) {
        const outcome = await runAutomationWithRetry(config, tabId, {
          sourceText: chunks[index],
          // Only the first chunk can come from the URL; the rest are typed.
          typeText: index > 0 || !first.includesText,
          // The previous chunk's translation is still on screen. Without this the
          // wait would settle immediately on that stale text and every chunk after
          // the first would return the first one's translation.
          previousText: index > 0 ? texts[index - 1] : "",
          shimMarkerAttribute:
          globalScope.ProviderVisibilityShim.markerAttribute,
        });

        const text = String(outcome?.text || "").trim();

        if (!outcome?.ok || !text) {
          return { ok: false };
        }

        texts.push(text);
      }

      return { ok: true, texts };
    } catch {
      return { ok: false };
    } finally {
      await closeProviderTab(tabId);
    }
  }

  async function runAttempt(config, attempt, chunk) {
    let tabId = null;

    try {
      // Re-assert the visibility shim before the tab exists, so it is registered
      // in time to run at document_start. Google renders through
      // requestAnimationFrame, which Chrome suspends in a hidden tab, so without
      // the shim this capture cannot succeed at all — see translation/provider-shim.js.
      await globalScope.ProviderVisibilityShim.sync();

      const tab = await openProviderTab(attempt.url);
      tabId = tab?.id ?? null;

      if (!tabId) {
        return { ok: false, error: `${config.label} tab could not be opened.` };
      }

      await rememberOwnedTab(tabId);

      const request = {
        sourceText: chunk,
        typeText: attempt.typeText,
        shimMarkerAttribute:
          globalScope.ProviderVisibilityShim.markerAttribute,
      };

      let outcome = await runAutomationWithRetry(config, tabId, request);

      // The page reports whether the shim actually arrived. If it did not, this
      // tab was never going to render Google's result — reload it now that
      // registration has been re-asserted, and give it one more go, rather than
      // failing with a timeout that says nothing about the real cause.
      if (!outcome?.ok && outcome?.shimMissing) {
        await chrome.tabs.reload(tabId);
        outcome = await runAutomationWithRetry(config, tabId, request);

        if (!outcome?.ok && outcome?.shimMissing) {
          const reason = globalScope.ProviderVisibilityShim.getLastError();
          return {
            ok: false,
            error: `${config.label} cannot render in a background tab because the page helper did not load${reason ? `: ${reason}` : "."}`,
          };
        }
      }

      return outcome;
    } catch (error) {
      return {
        ok: false,
        error:
          error?.message ||
          `${config.label} could not be read for this transcript.`,
      };
    } finally {
      await closeProviderTab(tabId);
    }
  }

  function normalizeConfig(providerConfig) {
    if (
      !providerConfig?.id ||
      !providerConfig?.hostPermission ||
      typeof providerConfig?.buildUrl !== "function"
    ) {
      throw new Error(
        "Translation providers require id, hostPermission, and buildUrl.",
      );
    }

    const selectors = providerConfig.selectors || {};
    const timing = { ...DEFAULT_TIMING, ...(providerConfig.timing || {}) };

    return Object.freeze({
      id: String(providerConfig.id),
      label: String(providerConfig.label || providerConfig.id),
      hostPermission: String(providerConfig.hostPermission),
      expectedHost: String(providerConfig.expectedHost || ""),
      maxChunkChars: Number(providerConfig.maxChunkChars) || 4000,
      buildUrl: providerConfig.buildUrl,
      timing: Object.freeze(timing),
      // Everything below crosses into the page via executeScript, so it must stay
      // JSON-serializable.
      pageConfig: Object.freeze({
        label: String(providerConfig.label || providerConfig.id),
        expectedHost: String(providerConfig.expectedHost || ""),
        timing,
        selectors: Object.freeze({
          input: String(selectors.input || ""),
          inputFallback: String(selectors.inputFallback || ""),
          output: Object.freeze({
            // A descent, one querySelector per step, each taking the FIRST match
            // inside the previous. Google needs this: the flattened CSS equivalent
            // of its chain also matches "Try again" and a handful of "." nodes, so
            // only the first-descendant walk lands on the translation alone.
            walk: Object.freeze([...(selectors.output?.walk || [])].map(String)),
            // Plain selectors, tried in order, all matches joined. Used when there
            // is no walk, and as the fallback when the walk finds nothing.
            selectors: Object.freeze(
              [...(selectors.output?.selectors || [])].map(String),
            ),
          }),
        }),
      }),
    });
  }

  async function openProviderTab(url) {
    return chrome.tabs.create({ url, active: false });
  }

  async function closeProviderTab(tabId) {
    if (!tabId) {
      return;
    }

    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Already closed (by the user, or by the orphan sweep).
    } finally {
      await forgetOwnedTab(tabId);
    }
  }

  // The worker can be torn down mid-capture, which skips the close above and
  // strands a hidden tab. Recording the tabs we own lets startup clean up after a
  // crash without touching provider tabs the user opened themselves.
  async function rememberOwnedTab(tabId) {
    try {
      const stored = await chrome.storage.session.get(OWNED_TABS_KEY);
      const owned = new Set(stored?.[OWNED_TABS_KEY] || []);
      owned.add(tabId);
      await chrome.storage.session.set({ [OWNED_TABS_KEY]: Array.from(owned) });
    } catch {
      // Session storage is unavailable; the tab still gets closed in `finally`.
    }
  }

  async function forgetOwnedTab(tabId) {
    try {
      const stored = await chrome.storage.session.get(OWNED_TABS_KEY);
      const owned = (stored?.[OWNED_TABS_KEY] || []).filter((id) => id !== tabId);
      await chrome.storage.session.set({ [OWNED_TABS_KEY]: owned });
    } catch {
      // Nothing to clean up.
    }
  }

  async function closeOwnedTabs() {
    const stored = await chrome.storage.session.get(OWNED_TABS_KEY);
    const owned = stored?.[OWNED_TABS_KEY] || [];

    await Promise.all(
      owned.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})),
    );

    await chrome.storage.session.set({ [OWNED_TABS_KEY]: [] });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Splits on paragraph, then sentence, then hard-wraps whatever is still too
  // long, so a chunk never lands mid-word if it can be helped.
  function splitIntoChunks(text, maxChars) {
    const limit = Math.max(200, Number(maxChars) || 4000);

    if (text.length <= limit) {
      return [text];
    }

    const pieces = text
      .split(/(?<=[.!?。！？\n])\s+/)
      .flatMap((piece) => (piece.length <= limit ? [piece] : hardWrap(piece, limit)));

    const chunks = [];
    let current = "";

    for (const piece of pieces) {
      if (!current) {
        current = piece;
        continue;
      }

      if (`${current} ${piece}`.length <= limit) {
        current = `${current} ${piece}`;
        continue;
      }

      chunks.push(current);
      current = piece;
    }

    if (current) {
      chunks.push(current);
    }

    return chunks.filter((chunk) => chunk.trim());
  }

  function hardWrap(text, limit) {
    const pieces = [];

    for (let index = 0; index < text.length; index += limit) {
      pieces.push(text.slice(index, index + limit));
    }

    return pieces;
  }

  function normalizeLanguage(value, fallback) {
    const normalized = String(value || "").trim().toLowerCase();

    if (!normalized || normalized === "auto") {
      return fallback === "auto" ? "auto" : normalized || fallback;
    }

    return normalized;
  }

  // Re-injects while the tab is still navigating (not injectable yet) or has not
  // reached the provider page. We do not gate on the tab's "complete" status:
  // heavy SPA pages report it unreliably, so the injected script decides when the
  // page is actually ready.
  async function runAutomationWithRetry(config, tabId, request) {
    const deadline =
      Date.now() + config.timing.tabLoadTimeoutMs + config.timing.pageTimeoutMs;
    let lastError = "";

    while (Date.now() < deadline) {
      let injectionResults = null;

      try {
        injectionResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: runPageAutomation,
          args: [config.pageConfig, request],
        });
      } catch (error) {
        lastError = error?.message || `${config.label} page is not reachable yet.`;
        await delay(config.timing.injectRetryDelayMs);
        continue;
      }

      const outcome = injectionResults?.[0]?.result;

      if (outcome?.ok) {
        return outcome;
      }

      // No result at all. The injection landed in a frame that was torn down
      // mid-navigation — the provider page redirects, and we inject as soon as the
      // tab exists, so this races by design. It is transient, not fatal: treating
      // it as fatal is what made Google fail with "could not be read", because
      // Google's redirect timing loses this race and DeepL's does not.
      if (!outcome) {
        lastError = `${config.label} page was still navigating.`;
        await delay(config.timing.injectRetryDelayMs);
        continue;
      }

      if (outcome.retryable) {
        lastError = outcome.error || lastError;
        await delay(config.timing.injectRetryDelayMs);
        continue;
      }

      return outcome;
    }

    return {
      ok: false,
      error: lastError || `${config.label} did not become ready in time.`,
    };
  }

  function createFailure(config, message) {
    return {
      providerId: config.id,
      translatedText: "",
      errorText: String(message || `${config.label} failed.`),
    };
  }

  // Runs in the provider page (serialized by executeScript). Fully self-contained:
  // every helper it uses is defined inline.
  async function runPageAutomation(config, request) {
    const selectors = config.selectors;
    const timing = config.timing;

    function normalizeText(value) {
      return String(value || "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function cleanTranslatedText(value) {
      // Google leaks Material icon ligatures into the text of its result container.
      return normalizeText(
        String(value || "").replace(/\b(star_border|content_copy|volume_up)\b/gi, " "),
      );
    }

    // Descends one selector at a time, taking the first match at each step.
    function readWalkText() {
      const steps = selectors.output.walk;

      if (!steps.length) {
        return "";
      }

      let node = document;

      for (const step of steps) {
        node = node.querySelector(step);

        if (!node) {
          return "";
        }
      }

      return cleanTranslatedText(node.textContent || "");
    }

    // `textContent`, never `innerText`: innerText is layout-dependent, and layout
    // does not run in a tab whose window is minimized, so it can come back empty
    // on exactly the pages we care about.
    function readOutputText() {
      const walked = readWalkText();

      if (walked) {
        return walked;
      }

      for (const selector of selectors.output.selectors) {
        if (!selector) {
          continue;
        }

        // Providers split a translation across sibling nodes (DeepL renders one
        // <p> per sentence), so every match is joined rather than just the first.
        const combined = Array.from(document.querySelectorAll(selector))
          .map((node) => node.textContent || "")
          .filter((text) => text.trim())
          .join("\n");

        const cleaned = cleanTranslatedText(combined);
        if (cleaned) {
          return cleaned;
        }
      }

      return "";
    }

    function isEditable(element) {
      if (!element) {
        return false;
      }

      return (
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLInputElement ||
        element.isContentEditable ||
        element.getAttribute("role") === "textbox"
      );
    }

    function resolveInputElement() {
      const candidates = [selectors.input, selectors.inputFallback].filter(Boolean);

      for (const selector of candidates) {
        const match = Array.from(document.querySelectorAll(selector)).find(isEditable);
        if (match) {
          return match;
        }
      }

      return null;
    }

    function setInputText(element, value) {
      const text = String(value || "");
      element.focus();

      if (
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLInputElement
      ) {
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

        if (descriptor?.set) {
          descriptor.set.call(element, text);
        } else {
          element.value = text;
        }
      } else {
        // Rich editors (DeepL) keep their own model of the content, so writing
        // textContent leaves them unaware anything changed. Drive a real edit.
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);

        if (!document.execCommand("insertText", false, text)) {
          element.dispatchEvent(
            new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              data: text,
              inputType: "insertText",
            }),
          );
          element.textContent = text;
        }
      }

      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: text,
          inputType: "insertText",
        }),
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function waitForElement(resolve_, timeoutMs, message) {
      return new Promise((resolve, reject) => {
        const existing = resolve_();
        if (existing) {
          resolve(existing);
          return;
        }

        let settled = false;

        const finish = (callback, value) => {
          if (settled) {
            return;
          }
          settled = true;
          observer.disconnect();
          clearTimeout(timeoutId);
          clearInterval(backstopId);
          callback(value);
        };

        const check = () => {
          const found = resolve_();
          if (found) {
            finish(resolve, found);
          }
        };

        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });

        const backstopId = setInterval(check, timing.backstopIntervalMs);
        const timeoutId = setTimeout(() => {
          finish(reject, new Error(message));
        }, timeoutMs);
      });
    }

    // A translation arrives as a burst of DOM mutations and then goes quiet. So:
    // watch for mutations, and accept the text once it has stopped changing for
    // `stableWindowMs`. The interval is only a backstop that lets that window
    // elapse on a page that has stopped mutating — Chrome clamps it to 1s in a
    // hidden tab, which is fine for that job and fatal for anything else.
    function waitForStableOutput(timeoutMs) {
      const previousText = String(request.previousText || "");

      return new Promise((resolve, reject) => {
        let lastText = "";
        let lastChangedAt = Date.now();
        let settled = false;

        const finish = (callback, value) => {
          if (settled) {
            return;
          }
          settled = true;
          observer.disconnect();
          clearTimeout(timeoutId);
          clearInterval(backstopId);
          callback(value);
        };

        const check = () => {
          const current = readOutputText();

          // When a tab is reused across chunks, the previous chunk's translation is
          // still sitting in the output. Treat it as "nothing yet", or the wait
          // settles on stale text and every later chunk returns the first one's
          // translation.
          if (!current || current === previousText) {
            return;
          }

          if (current !== lastText) {
            lastText = current;
            lastChangedAt = Date.now();
            return;
          }

          if (Date.now() - lastChangedAt >= timing.stableWindowMs) {
            finish(resolve, current);
          }
        };

        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });

        const backstopId = setInterval(check, timing.backstopIntervalMs);
        const timeoutId = setTimeout(() => {
          finish(
            reject,
            new Error(`${config.label} did not produce a translation in time.`),
          );
        }, timeoutMs);

        check();
      });
    }

    // Still navigating, or on a redirect/interstitial. Ask the caller to retry.
    if (
      config.expectedHost &&
      !window.location.hostname.endsWith(config.expectedHost)
    ) {
      return {
        ok: false,
        retryable: true,
        error: `${config.label} page is not ready yet (on ${window.location.hostname || "about:blank"}).`,
      };
    }

    // The shim marks the <html> element. It cannot signal us through `window`:
    // this code runs in the extension's ISOLATED world and the shim runs in the
    // page's MAIN world, so the two have different `window` objects and share only
    // the DOM. Knowing whether the shim arrived is what separates "the page is
    // slow" from "the page was never going to render".
    const shimActive = document.documentElement.hasAttribute(
      request.shimMarkerAttribute,
    );

    // Read the *native* getter: the shim overrides visibilityState on the document
    // instance, so the plain property would always answer "visible" once it is in.
    let reallyHidden = false;
    try {
      reallyHidden =
        Object.getOwnPropertyDescriptor(
          Document.prototype,
          "visibilityState",
        )?.get?.call(document) === "hidden";
    } catch {
      reallyHidden = false;
    }

    try {
      if (request.typeText) {
        const inputElement = await waitForElement(
          resolveInputElement,
          timing.pageTimeoutMs,
          `${config.label} input field was not found in time.`,
        );

        setInputText(inputElement, normalizeText(request.sourceText));
      }

      const translatedText = await waitForStableOutput(timing.pageTimeoutMs);
      return { ok: true, text: translatedText, shimActive };
    } catch (error) {
      return {
        ok: false,
        shimActive,
        // Only a real diagnosis when the tab is actually hidden: a visible tab
        // renders with or without the shim, so a failure there is a different bug.
        shimMissing: !shimActive && reallyHidden,
        error: error?.message || `${config.label} could not be read.`,
      };
    }
  }

  globalScope.WonderTranslationAutomation = Object.freeze({
    createBrowserTranslationProvider,
    closeOwnedTabs,
    splitIntoChunks,
    // Exposed so it can be exercised in a real browser exactly as
    // chrome.scripting.executeScript runs it: serialized, in an isolated world.
    // Testing it any other way misses that the page's MAIN world and this
    // isolated world do not share a `window`.
    runPageAutomation,
  });
})(self);
