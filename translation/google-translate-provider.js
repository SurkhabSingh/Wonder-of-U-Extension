(function initializeGoogleTranslateProvider(globalScope) {
  "use strict";

  const PROVIDER_ID = "google-translate";
  const PROVIDER_CONFIG = Object.freeze({
    url: "https://translate.google.com/",
    hostPermission: "https://translate.google.com/*",
    tabLoadTimeoutMs: 15000,
    pageTimeoutMs: 20000,
    pollIntervalMs: 100,
    stableWindowMs: 1200,
    selectors: Object.freeze({
      inputCandidates:
        "textarea, input[type='text'], [contenteditable='true'], [role='textbox']",
      outputAnchor: "span",
      outputAnchorText: "Send feedback",
      outputContainer: 'div[jsaction^="copy:"]',
    }),
  });

  async function capture(sourceText) {
    const normalizedSource = String(sourceText || "").trim();

    if (!normalizedSource) {
      return createFailure("The transcript was empty.");
    }

    const hasPermission = await chrome.permissions.contains({
      origins: [PROVIDER_CONFIG.hostPermission],
    });

    if (!hasPermission) {
      return createFailure("Google Translate permission is missing.");
    }

    try {
      const tab = await getOrCreateProviderTab();
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: runPageAutomation,
        args: [normalizedSource, PROVIDER_CONFIG],
      });

      const translatedText = String(result || "").trim();
      if (!translatedText) {
        return createFailure("Google Translate returned an empty result.");
      }

      return {
        providerId: PROVIDER_ID,
        translatedText,
        errorText: "",
      };
    } catch (error) {
      return createFailure(
        error?.message ||
          "Google Translate could not be read for this transcript.",
      );
    }
  }

  async function getOrCreateProviderTab() {
    const [existingTab] = await chrome.tabs.query({
      url: [PROVIDER_CONFIG.hostPermission],
    });

    if (existingTab?.id) {
      await waitForTabComplete(existingTab.id);
      return existingTab;
    }

    const createdTab = await chrome.tabs.create({
      url: PROVIDER_CONFIG.url,
      active: false,
    });

    await waitForTabComplete(createdTab.id);
    return createdTab;
  }

  async function waitForTabComplete(tabId) {
    if (!tabId) {
      throw new Error("Google Translate tab could not be created.");
    }

    const currentTab = await chrome.tabs.get(tabId);
    if (currentTab.status === "complete") {
      return;
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeoutId);
      };

      const finish = (callback) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        callback();
      };

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== "complete") {
          return;
        }

        finish(resolve);
      };

      const timeoutId = setTimeout(() => {
        finish(() => {
          reject(new Error("Google Translate did not finish loading in time."));
        });
      }, PROVIDER_CONFIG.tabLoadTimeoutMs);

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  function createFailure(message) {
    return {
      providerId: PROVIDER_ID,
      translatedText: "",
      errorText: String(message || "Google Translate failed."),
    };
  }

  async function runPageAutomation(sourceText, config) {
    const selectors = config.selectors;

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
      return normalizeText(
        String(value || "").replace(/\bstar_border\b/gi, " "),
      );
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
      return (
        Array.from(document.querySelectorAll(selectors.inputCandidates))
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
          .sort((left, right) => right.score - left.score)[0]?.element || null
      );
    }

    function resolveOutputState() {
      const anchor = Array.from(
        document.querySelectorAll(selectors.outputAnchor),
      ).find(
        (element) =>
          isVisible(element) &&
          String(element.textContent || "").trim() ===
            selectors.outputAnchorText,
      );
      const outputNode = anchor
        ?.closest(selectors.outputAnchor)
        ?.previousElementSibling?.querySelector(selectors.outputContainer);

      return {
        node: outputNode || null,
        text: cleanTranslatedText(
          outputNode?.innerText || outputNode?.textContent || "",
        ),
      };
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
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);

        if (!document.execCommand("insertText", false, text)) {
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

    const inputElement = await waitUntil(
      resolveInputElement,
      config.pageTimeoutMs,
      config.pollIntervalMs,
      "Google Translate input field was not found in time.",
    );
    const normalizedSource = normalizeText(sourceText);
    const baselineText = resolveOutputState().text;

    setInputText(inputElement, "");

    let outputWasCleared = !resolveOutputState().text;
    if (!outputWasCleared && baselineText) {
      try {
        await waitUntil(
          () => {
            outputWasCleared = !resolveOutputState().text;
            return outputWasCleared;
          },
          Math.min(3000, config.pageTimeoutMs),
          config.pollIntervalMs,
          "Google Translate output did not clear.",
        );
      } catch {
        outputWasCleared = false;
      }
    }

    setInputText(inputElement, normalizedSource);

    let lastText = "";
    let lastChangedAt = Date.now();

    return waitUntil(
      () => {
        const currentText = resolveOutputState().text;
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
      "Google Translate has not produced a fresh translated text yet.",
    );
  }

  globalScope.GoogleTranslateProvider = Object.freeze({
    id: PROVIDER_ID,
    config: PROVIDER_CONFIG,
    capture,
  });
})(self);
