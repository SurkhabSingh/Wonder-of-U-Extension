(function initializeTranslationAutomation(globalScope) {
  "use strict";

  // Chrome clamps timers to ~1s in hidden tabs, so the page renders (and our
  // in-page polling runs) far slower in the background than in a focused tab.
  // These budgets are sized for the throttled case.
  const DEFAULT_TIMING = Object.freeze({
    tabLoadTimeoutMs: 15000,
    pageTimeoutMs: 45000,
    pollIntervalMs: 100,
    stableWindowMs: 1500,
  });

  // Builds a browser-assisted translation provider that drives a provider
  // website (Google Translate, DeepL, ...) through DOM automation. Every part
  // of `config` is JSON-serializable so the page automation can be handed to
  // `chrome.scripting.executeScript` unchanged.
  function createBrowserTranslationProvider(providerConfig) {
    const config = normalizeConfig(providerConfig);

    async function capture(sourceText) {
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

      let tabId = null;

      try {
        const tab = await openProviderTab(config);
        tabId = tab?.id ?? null;

        const outcome = await runAutomationWithRetry(config, tabId, normalizedSource);

        if (!outcome?.ok) {
          return createFailure(
            config,
            outcome?.error ||
              `${config.label} could not be read for this transcript.`,
          );
        }

        const translatedText = String(outcome.text || "").trim();
        if (!translatedText) {
          return createFailure(config, `${config.label} returned an empty result.`);
        }

        return {
          providerId: config.id,
          translatedText,
          errorText: "",
        };
      } catch (error) {
        return createFailure(
          config,
          error?.message ||
            `${config.label} could not be read for this transcript.`,
        );
      } finally {
        await closeProviderTab(tabId);
      }
    }

    return Object.freeze({
      id: config.id,
      config,
      capture,
    });
  }

  function normalizeConfig(providerConfig) {
    if (!providerConfig?.id || !providerConfig?.url || !providerConfig?.hostPermission) {
      throw new Error(
        "Translation providers require id, url, and hostPermission.",
      );
    }

    const selectors = providerConfig.selectors || {};
    const output = selectors.output || {};

    return Object.freeze({
      id: String(providerConfig.id),
      label: String(providerConfig.label || providerConfig.id),
      url: String(providerConfig.url),
      hostPermission: String(providerConfig.hostPermission),
      expectedHost: String(
        providerConfig.expectedHost ||
          String(providerConfig.url)
            .replace(/^[a-z]+:\/\//i, "")
            .split(/[/?#]/)[0] ||
          "",
      ),
      tabLoadTimeoutMs:
        providerConfig.tabLoadTimeoutMs || DEFAULT_TIMING.tabLoadTimeoutMs,
      pageTimeoutMs:
        providerConfig.pageTimeoutMs || DEFAULT_TIMING.pageTimeoutMs,
      pollIntervalMs:
        providerConfig.pollIntervalMs || DEFAULT_TIMING.pollIntervalMs,
      stableWindowMs:
        providerConfig.stableWindowMs || DEFAULT_TIMING.stableWindowMs,
      selectors: Object.freeze({
        input: String(selectors.input || ""),
        inputFallbackCandidates: String(selectors.inputFallbackCandidates || ""),
        output: Object.freeze({
          mode: String(output.mode || "text"),
          selector: String(output.selector || ""),
          // Used when `selector` matches nothing — e.g. DeepL renders one <p>
          // per sentence, but drops to a bare text node for a short phrase.
          fallbackSelector: String(output.fallbackSelector || ""),
          container: String(output.container || ""),
          anchorSelector: String(output.anchorSelector || ""),
          anchorText: String(output.anchorText || ""),
        }),
      }),
    });
  }

  // Always drives a dedicated background tab, which is then closed. We do not
  // reuse an existing provider tab: any deepl.com tab (pricing, docs, ...) would
  // match the host pattern without having a translator on it, and a long-lived
  // hidden tab hits Chrome's intensive timer throttling (~1 wake-up/minute after
  // 5 minutes hidden), which stalls batch translation.
  async function openProviderTab(config) {
    return chrome.tabs.create({
      url: config.url,
      active: false,
    });
  }

  async function closeProviderTab(tabId) {
    if (!tabId) {
      return;
    }

    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // The tab was already closed (e.g. by the user) — nothing to clean up.
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Injects the page automation and retries while the tab is still navigating
  // (not injectable yet) or has not reached the provider page. We do NOT gate on
  // the tab's "complete" status because heavy/SPA provider pages report it
  // unreliably; instead the injected `waitUntil` decides when elements are ready.
  async function runAutomationWithRetry(config, tabId, sourceText) {
    if (!tabId) {
      return { ok: false, error: `${config.label} tab could not be opened.` };
    }

    const deadline = Date.now() + config.tabLoadTimeoutMs + config.pageTimeoutMs;
    let lastError = "";

    while (Date.now() < deadline) {
      let injectionResults = null;

      try {
        injectionResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: runPageAutomation,
          args: [sourceText, config],
        });
      } catch (error) {
        // The frame is not injectable yet (still navigating / no document).
        lastError = error?.message || `${config.label} page is not reachable yet.`;
        await delay(400);
        continue;
      }

      const outcome = injectionResults?.[0]?.result;

      if (outcome?.ok) {
        return outcome;
      }

      if (outcome?.retryable) {
        // On the wrong document (about:blank or a redirect) — wait and retry.
        lastError = outcome.error || lastError;
        await delay(400);
        continue;
      }

      // A real, non-retryable automation failure (e.g. selectors not found).
      return (
        outcome || {
          ok: false,
          error: `${config.label} could not be read for this transcript.`,
        }
      );
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

  // Runs in the provider page's context (serialized by executeScript). Keep it
  // fully self-contained: every helper it uses must be defined inline here.
  async function runPageAutomation(sourceText, config) {
    const selectors = config.selectors;
    const outputConfig = selectors.output;

    function waitUntil(
      predicate,
      timeoutMs = 10000,
      intervalMs = 100,
      timeoutMessage = "The expected page condition was not met in time.",
    ) {
      return new Promise((resolve, reject) => {
        let intervalId = null;
        let timeoutId = null;
        let settled = false;

        const cleanup = () => {
          if (intervalId !== null) {
            window.clearInterval(intervalId);
          }
          if (timeoutId !== null) {
            window.clearTimeout(timeoutId);
          }
        };

        const finish = (callback, value) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          callback(value);
        };

        const evaluate = () => {
          try {
            const value = predicate();
            if (value) {
              finish(resolve, value);
            }
          } catch (error) {
            finish(reject, error);
          }
        };

        intervalId = window.setInterval(evaluate, intervalMs);
        timeoutId = window.setTimeout(() => {
          finish(reject, new Error(timeoutMessage));
        }, timeoutMs);

        evaluate();
      });
    }

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
      return normalizeText(String(value || "").replace(/\bstar_border\b/gi, " "));
    }

    function isVisible(element) {
      if (!element) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
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
      const primaryMatches = selectors.input
        ? Array.from(document.querySelectorAll(selectors.input))
        : [];

      const primary = primaryMatches.find(
        (element) => isEditable(element) && isVisible(element),
      );

      if (primary) {
        return primary;
      }

      if (!selectors.inputFallbackCandidates) {
        // A never-painted background tab can report zero-sized rects, so accept
        // an editable match that only failed the visibility check.
        return primaryMatches.find(isEditable) || null;
      }

      return (
        Array.from(
          document.querySelectorAll(selectors.inputFallbackCandidates),
        )
          .filter((element) => isEditable(element) && isVisible(element))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const label = String(
              element.getAttribute("aria-label") ||
                element.getAttribute("data-placeholder") ||
                element.getAttribute("placeholder") ||
                "",
            ).toLowerCase();
            let score = 0;

            if (rect.left < window.innerWidth * 0.6) {
              score += 40;
            }
            if (rect.width >= 120) {
              score += 20;
            }
            if (rect.height >= 32) {
              score += 15;
            }
            if (
              label.includes("source") ||
              label.includes("translate") ||
              label.includes("text")
            ) {
              score += 30;
            }

            return { element, score };
          })
          .sort((left, right) => right.score - left.score)[0]?.element ||
        primaryMatches.find(isEditable) ||
        null
      );
    }

    function extractGoogleCopySpan() {
      const container = outputConfig.container
        ? document.querySelector(outputConfig.container)
        : null;
      if (!container) {
        return "";
      }

      const ltrDiv = container.querySelector('div div[dir="ltr"]');
      if (!ltrDiv) {
        return "";
      }

      // Walk the nested spans Google renders for the translated string; fall
      // back to the container text if the structure shifts.
      let node = ltrDiv;
      for (let depth = 0; depth < 3; depth += 1) {
        const span = node.querySelector("span");
        if (!span) {
          break;
        }
        node = span;
      }

      return cleanTranslatedText(
        node?.innerText || node?.textContent || ltrDiv.textContent || "",
      );
    }

    function extractAnchorSibling() {
      if (!outputConfig.anchorSelector || !outputConfig.anchorText) {
        return "";
      }

      const anchor = Array.from(
        document.querySelectorAll(outputConfig.anchorSelector),
      ).find(
        (element) =>
          isVisible(element) &&
          String(element.textContent || "").trim() === outputConfig.anchorText,
      );
      const outputNode = anchor
        ?.closest(outputConfig.anchorSelector)
        ?.previousElementSibling?.querySelector(outputConfig.container);

      return cleanTranslatedText(
        outputNode?.innerText || outputNode?.textContent || "",
      );
    }

    function resolveOutputText() {
      if (outputConfig.mode === "google-copy-span") {
        return extractGoogleCopySpan() || extractAnchorSibling();
      }

      // Plain-text mode (e.g. DeepL): providers may split the translation across
      // several sibling elements (one per sentence), so join them all.
      if (!outputConfig.selector) {
        return "";
      }

      const combined = Array.from(
        document.querySelectorAll(outputConfig.selector),
      )
        .map((node) => node.innerText || node.textContent || "")
        .filter((text) => text.trim())
        .join("\n");

      if (combined.trim() || !outputConfig.fallbackSelector) {
        return cleanTranslatedText(combined);
      }

      const fallbackNode = document.querySelector(outputConfig.fallbackSelector);
      return cleanTranslatedText(
        fallbackNode?.innerText || fallbackNode?.textContent || "",
      );
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
      } else if (
        element.isContentEditable ||
        element.getAttribute("role") === "textbox"
      ) {
        // Rich editors (DeepL) hold their own model of the content, so writing
        // textContent leaves them unaware that anything changed. Drive it as a
        // real edit instead: select everything, then insert — or delete, when
        // clearing — and only fall back to a raw write if that is refused.
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);

        const applied = text
          ? document.execCommand("insertText", false, text)
          : document.execCommand("delete");

        if (!applied) {
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
          inputType: text ? "insertText" : "deleteContentBackward",
        }),
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Bail early (and ask the caller to retry) if the tab has not reached the
    // provider page yet — e.g. it is still on about:blank or a redirect.
    if (
      config.expectedHost &&
      !window.location.hostname.includes(config.expectedHost)
    ) {
      return {
        ok: false,
        retryable: true,
        error: `${config.label} page is not ready yet (on ${window.location.hostname || "about:blank"}).`,
      };
    }

    try {
      const inputElement = await waitUntil(
        resolveInputElement,
        config.pageTimeoutMs,
        config.pollIntervalMs,
        `${config.label} input field was not found in time.`,
      );
      const normalizedSource = normalizeText(sourceText);
      const baselineText = resolveOutputText();

      setInputText(inputElement, "");

      let outputWasCleared = !resolveOutputText();
      if (!outputWasCleared && baselineText) {
        try {
          await waitUntil(
            () => {
              outputWasCleared = !resolveOutputText();
              return outputWasCleared;
            },
            Math.min(3000, config.pageTimeoutMs),
            config.pollIntervalMs,
            `${config.label} output did not clear.`,
          );
        } catch {
          outputWasCleared = false;
        }
      }

      setInputText(inputElement, normalizedSource);

      let lastText = "";
      let lastChangedAt = Date.now();

      const translatedText = await waitUntil(
        () => {
          const currentText = resolveOutputText();
          if (!currentText) {
            outputWasCleared = true;
            return null;
          }

          const isFresh =
            outputWasCleared || !baselineText || currentText !== baselineText;
          if (!isFresh) {
            return null;
          }

          if (currentText !== lastText) {
            lastText = currentText;
            lastChangedAt = Date.now();
            return null;
          }

          return Date.now() - lastChangedAt >= config.stableWindowMs
            ? currentText
            : null;
        },
        config.pageTimeoutMs,
        config.pollIntervalMs,
        `${config.label} has not produced a fresh translated text yet.`,
      );

      return { ok: true, text: translatedText };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || `${config.label} could not be read.`,
      };
    }
  }

  globalScope.WonderTranslationAutomation = Object.freeze({
    createBrowserTranslationProvider,
  });
})(self);
