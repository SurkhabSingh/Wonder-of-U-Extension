// Subtitle-mining overlay — runs as an ISOLATED-world content script in every
// frame (registered by overlay-shim.js only once <all_urls> is granted). In a
// frame that has a <video>, it renders the user's subtitle file synced to the
// video clock; a subtitle file dropped anywhere in the tab is parsed and shared
// across frames via chrome.storage.session, so the drop need not land on the
// player frame. ISOLATED world: shares the DOM (read currentTime, draw overlay)
// but is invisible to the page's own scripts and their anti-DevTools traps.
(function () {
  "use strict";

  // Registered content scripts can be injected more than once (SPA nav, re-sync);
  // guard so we only wire one instance per frame.
  if (window.__wonderSubtitleOverlayLoaded) {
    return;
  }
  window.__wonderSubtitleOverlayLoaded = true;

  const OVERLAY_ID = "wonder-of-u-subtitle-overlay";
  // Cues are scoped to the tab (`subtitleCues_<tabId>`) so a subtitle loaded on
  // one video never shows up on a different tab or a later episode; the key is
  // shared across this tab's frames so a drop on the page still reaches the
  // player iframe. Background clears the key on navigation / tab close.
  const SESSION_CUES_PREFIX = "subtitleCues_";
  const SETTINGS_KEY = "subtitleSettings"; // chrome.storage.local
  const OFFSET_STEP_MS = 200;

  const DEFAULT_FONT_SIZE_PX = 28;
  const DEFAULT_TEXT_COLOR = "#ffffff";

  let sessionCuesKey = null; // "subtitleCues_<tabId>", set once the tab id resolves
  let enabled = false; // gates all behaviour; true only when this site is opted in
  let siteActive = false; // whether the background says this tab's host is enabled
  let cues = [];
  let offsetMs = 0;
  let fontSizePx = DEFAULT_FONT_SIZE_PX;
  let textColor = DEFAULT_TEXT_COLOR;
  let video = null;
  let overlayEl = null;
  let textEl = null;
  let activeIndex = -1;
  let rafHandle = null;
  let videoPollTimer = null;
  let lastRescanAt = 0;
  let panelEl = null;
  let offsetInputEl = null;
  let sizeInputEl = null;
  let colorInputEl = null;
  let jimakuButtonEl = null;
  let autoSyncStatusEl = null;
  let manualListEl = null; // scrollable cue list inside the manual-sync dialog
  let manualSearchEl = null;
  let manualDialogEl = null;
  let jimakuDialogEl = null;
  let tabTitle = ""; // top-page title, used to seed the Jimaku search
  let autosyncAnchorMs = null; // video-time (ms) captured when audio capture starts

  // Auto-sync is driven by the background (popup button / Ctrl+Shift+3 → tab-audio
  // capture in the offscreen doc), which pushes these messages back to the tab.
  chrome.runtime.onMessage.addListener((message) => {
    if (!message) {
      return;
    }
    if (message.type === "autosync-started") {
      // Anchor the audio window: reading currentTime now marks capture-start in
      // video time (getUserMedia setup adds ~1s the trigger-time read would miss).
      if (video) {
        autosyncAnchorMs = video.currentTime * 1000;
      }
      setAutoSyncStatus("Listening to the audio (~12s)…");
    } else if (message.type === "autosync-run") {
      setAutoSyncStatus("Matching the transcript to the subtitles…");
      applyAutoSyncTranscript(message.segments);
    } else if (message.type === "autosync-error") {
      setAutoSyncStatus(message.error || "Auto-sync failed.");
    } else if (message.type === "subtitle-active") {
      // The popup toggled this site on/off — activate or tear down live.
      enabled = Boolean(message.active);
      siteActive = enabled;
      applyEnabledState();
    }
  });

  function setAutoSyncStatus(text) {
    if (autoSyncStatusEl) {
      autoSyncStatusEl.textContent = text;
    }
  }

  // --- Active-video detection (same selection logic proven by the spike) ------
  function collectVideos() {
    const found = [];
    const seen = new Set();
    const visit = (root) => {
      let direct = [];
      try {
        direct = root.querySelectorAll("video");
      } catch (_) {
        direct = [];
      }
      for (const el of direct) {
        if (!seen.has(el)) {
          seen.add(el);
          found.push(el);
        }
      }
      let all = [];
      try {
        all = root.querySelectorAll("*");
      } catch (_) {
        all = [];
      }
      for (const el of all) {
        if (el.shadowRoot) {
          visit(el.shadowRoot);
        }
      }
    };
    visit(document);
    return found;
  }

  function pickActiveVideo() {
    const videos = collectVideos();
    if (!videos.length) {
      return null;
    }
    const playing = videos.find((v) => !v.paused && v.readyState >= 2);
    if (playing) {
      return playing;
    }
    const area = (el) => {
      const rect = el.getBoundingClientRect();
      return Math.max(0, rect.width) * Math.max(0, rect.height);
    };
    return videos.slice().sort((a, b) => area(b) - area(a))[0];
  }

  // --- Overlay element ---------------------------------------------------------
  function ensureOverlay() {
    if (overlayEl && overlayEl.isConnected) {
      return;
    }
    overlayEl = document.createElement("div");
    overlayEl.id = OVERLAY_ID;
    overlayEl.setAttribute("aria-live", "off");
    Object.assign(overlayEl.style, {
      position: "fixed",
      left: "50%",
      bottom: "8%",
      transform: "translateX(-50%)",
      maxWidth: "90%",
      zIndex: "2147483647",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 80ms linear",
      textAlign: "center",
    });

    textEl = document.createElement("span");
    Object.assign(textEl.style, {
      display: "inline-block",
      padding: "0.15em 0.5em",
      background: "rgba(0, 0, 0, 0.75)",
      fontWeight: "600",
      lineHeight: "1.35",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      whiteSpace: "pre-wrap",
      borderRadius: "6px",
      textShadow: "0 1px 3px rgba(0, 0, 0, 0.9)",
      // The mined text must be selectable so popup dictionaries (Yomitan) can
      // scan it; the container is click-through, this span re-enables pointers.
      pointerEvents: "auto",
      userSelect: "text",
      cursor: "default",
    });

    overlayEl.appendChild(textEl);
    overlayParent().appendChild(overlayEl);
    applyAppearance();
  }

  // Applies the user's size/color choices to the live cue text.
  function applyAppearance() {
    if (textEl) {
      textEl.style.fontSize = `${fontSizePx}px`;
      textEl.style.color = textColor;
    }
  }

  // --- Control panel (size / color / offset + subtitle source) ----------------
  function makeEl(tag, styles, text) {
    const node = document.createElement(tag);
    if (styles) {
      Object.assign(node.style, styles);
    }
    if (text != null) {
      node.textContent = text;
    }
    return node;
  }

  function makeStepButton(label) {
    return makeEl(
      "button",
      {
        minWidth: "28px",
        height: "26px",
        borderRadius: "6px",
        border: "none",
        background: "rgba(255, 255, 255, 0.14)",
        color: "#fff",
        fontSize: "16px",
        lineHeight: "1",
        cursor: "pointer",
      },
      label,
    );
  }

  function labeledRow(labelText) {
    const row = makeEl("div", {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
    });
    row.appendChild(makeEl("span", { opacity: "0.7" }, labelText));
    return row;
  }

  function updateOffsetReadout() {
    // Don't fight the user while they are typing in the field.
    if (offsetInputEl && document.activeElement !== offsetInputEl) {
      offsetInputEl.value = (offsetMs / 1000).toFixed(1);
    }
  }

  // Pushes the current appearance/offset back into the panel controls, e.g. after
  // settings load asynchronously or another surface changes them.
  function syncControls() {
    if (sizeInputEl) {
      sizeInputEl.value = String(fontSizePx);
    }
    if (colorInputEl) {
      colorInputEl.value = textColor;
    }
    updateOffsetReadout();
    applyAppearance();
  }

  function ensureControlPanel() {
    if ((panelEl && panelEl.isConnected) || !document.body) {
      return;
    }

    const wrap = makeEl("div", {
      position: "fixed",
      right: "16px",
      bottom: "12%",
      zIndex: "2147483647",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-end",
      gap: "8px",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });
    panelEl = wrap;

    const panel = makeEl("div", {
      display: "none",
      flexDirection: "column",
      gap: "12px",
      padding: "14px",
      width: "230px",
      background: "rgba(20, 20, 23, 0.96)",
      color: "#fff",
      borderRadius: "12px",
      boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
      fontSize: "13px",
      pointerEvents: "auto",
      userSelect: "none",
    });

    // Size
    const sizeRow = makeEl("label", {
      display: "flex",
      flexDirection: "column",
      gap: "5px",
    });
    sizeRow.appendChild(makeEl("span", { opacity: "0.7" }, "Subtitle size"));
    sizeInputEl = makeEl("input", { width: "100%", cursor: "pointer" });
    sizeInputEl.type = "range";
    sizeInputEl.min = "14";
    sizeInputEl.max = "64";
    sizeInputEl.step = "1";
    sizeInputEl.value = String(fontSizePx);
    sizeInputEl.addEventListener("input", () => {
      fontSizePx = Number(sizeInputEl.value) || DEFAULT_FONT_SIZE_PX;
      applyAppearance();
      persistAppearance();
    });
    sizeRow.appendChild(sizeInputEl);

    // Color
    const colorRow = labeledRow("Text color");
    colorInputEl = makeEl("input", { cursor: "pointer", background: "none" });
    colorInputEl.type = "color";
    colorInputEl.value = textColor;
    colorInputEl.addEventListener("input", () => {
      textColor = colorInputEl.value || DEFAULT_TEXT_COLOR;
      applyAppearance();
      persistAppearance();
    });
    colorRow.appendChild(colorInputEl);

    // Offset
    const offsetRow = labeledRow("Offset");
    const offsetControls = makeEl("div", {
      display: "flex",
      alignItems: "center",
      gap: "6px",
    });
    const minus = makeStepButton("−");
    const plus = makeStepButton("+");
    offsetInputEl = makeEl("input", {
      width: "56px",
      textAlign: "center",
      padding: "3px 4px",
      borderRadius: "6px",
      border: "1px solid rgba(255, 255, 255, 0.15)",
      background: "rgba(255, 255, 255, 0.06)",
      color: "#fff",
      fontSize: "13px",
    });
    offsetInputEl.type = "number";
    offsetInputEl.step = "0.1";
    offsetInputEl.title = "Seconds (positive delays the subtitles)";
    offsetInputEl.addEventListener("change", () => {
      const seconds = Number(offsetInputEl.value);
      if (Number.isFinite(seconds)) {
        setOffset(Math.round(seconds * 1000));
      }
    });
    minus.addEventListener("click", () => setOffset(offsetMs - OFFSET_STEP_MS));
    plus.addEventListener("click", () => setOffset(offsetMs + OFFSET_STEP_MS));
    offsetControls.append(minus, offsetInputEl, makeEl("span", { opacity: "0.6" }, "s"), plus);
    offsetRow.appendChild(offsetControls);

    // Subtitle source (the Jimaku button is wired in slice 3)
    const sourceRow = makeEl("div", {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      borderTop: "1px solid rgba(255, 255, 255, 0.12)",
      paddingTop: "10px",
    });
    jimakuButtonEl = makeEl(
      "button",
      {
        padding: "7px 10px",
        borderRadius: "8px",
        border: "none",
        background: "#2878d0",
        color: "#fff",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
      },
      "Search Jimaku",
    );
    jimakuButtonEl.addEventListener("click", openJimakuDialog);
    sourceRow.appendChild(jimakuButtonEl);
    sourceRow.appendChild(
      makeEl(
        "span",
        { opacity: "0.55", fontSize: "12px" },
        "or drop a .srt / .ass file onto the page",
      ),
    );

    // Auto-sync must be triggered by a real extension invocation (Chrome only lets
    // it capture tab audio then): the toolbar popup's button or Ctrl+Shift+3. The
    // result lands here.
    sourceRow.appendChild(
      makeEl(
        "span",
        { opacity: "0.55", fontSize: "12px", marginTop: "4px" },
        "Auto-sync: press Ctrl+Shift+3 (or the popup button)",
      ),
    );
    autoSyncStatusEl = makeEl("span", { opacity: "0.8", fontSize: "12px" });
    sourceRow.appendChild(autoSyncStatusEl);

    // Manual anchor — the always-reliable fallback. Opens a readable picker; click
    // the line you hear right now and the offset snaps so that line shows at the
    // current video time. No ML, always works.
    const manualRow = makeEl("div", {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      borderTop: "1px solid rgba(255, 255, 255, 0.12)",
      paddingTop: "10px",
    });
    const manualButton = makeEl(
      "button",
      {
        padding: "7px 10px",
        borderRadius: "8px",
        border: "none",
        background: "rgba(255, 255, 255, 0.14)",
        color: "#fff",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
      },
      "Sync to a line manually",
    );
    manualButton.addEventListener("click", openManualSyncDialog);
    manualRow.appendChild(manualButton);
    manualRow.appendChild(
      makeEl(
        "span",
        { opacity: "0.55", fontSize: "12px" },
        "Pick the line being spoken now for an exact sync.",
      ),
    );

    panel.append(sizeRow, colorRow, offsetRow, sourceRow, manualRow);

    const handle = makeEl(
      "button",
      {
        width: "40px",
        height: "40px",
        borderRadius: "50%",
        border: "none",
        background: "rgba(20, 20, 23, 0.9)",
        color: "#fff",
        fontSize: "15px",
        fontWeight: "700",
        cursor: "pointer",
        pointerEvents: "auto",
        boxShadow: "0 4px 14px rgba(0, 0, 0, 0.4)",
      },
      "字",
    );
    handle.title = "Subtitle controls";
    handle.addEventListener("click", () => {
      panel.style.display = panel.style.display === "none" ? "flex" : "none";
    });

    wrap.append(panel, handle);
    overlayParent().appendChild(wrap);

    syncControls();
  }

  function persistAppearance() {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (result) => {
        const current = (result && result[SETTINGS_KEY]) || {};
        chrome.storage.local.set({
          [SETTINGS_KEY]: { ...current, offsetMs, fontSizePx, textColor },
        });
      });
    } catch (_) {
      /* storage unavailable — controls still work for this frame */
    }
  }

  // --- Jimaku search dialog ----------------------------------------------------
  function closeJimakuDialog() {
    if (jimakuDialogEl && jimakuDialogEl.isConnected) {
      jimakuDialogEl.remove();
    }
    jimakuDialogEl = null;
  }

  // Best-effort anime name from the tab title (strip site/episode noise).
  function titleGuess() {
    return String(tabTitle || "")
      .replace(/\s*[-|–—:].*$/, "")
      .replace(
        /\b(watch|online|episode|ep\.?|sub|dub|english|hd|1080p|720p|free)\b/gi,
        "",
      )
      .replace(/\s+\d{1,3}\s*$/, "") // a trailing number is usually the episode
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function makeResultButton(label) {
    return makeEl(
      "button",
      {
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: "8px",
        border: "none",
        background: "rgba(255, 255, 255, 0.08)",
        color: "#fff",
        fontSize: "13px",
        cursor: "pointer",
        whiteSpace: "normal",
        wordBreak: "break-word",
      },
      label,
    );
  }

  function openJimakuDialog() {
    closeJimakuDialog();

    const backdrop = makeEl("div", {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0, 0, 0, 0.5)",
      pointerEvents: "auto",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });
    jimakuDialogEl = backdrop;
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        closeJimakuDialog();
      }
    });

    const dialog = makeEl("div", {
      width: "440px",
      maxWidth: "92vw",
      maxHeight: "80vh",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      padding: "16px",
      background: "rgba(20, 20, 23, 0.98)",
      color: "#fff",
      borderRadius: "12px",
      boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
      fontSize: "13px",
    });

    const header = makeEl("div", {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    });
    header.appendChild(makeEl("strong", null, "Jimaku subtitles"));
    const closeBtn = makeEl(
      "button",
      {
        border: "none",
        background: "none",
        color: "#fff",
        fontSize: "18px",
        cursor: "pointer",
        lineHeight: "1",
      },
      "✕",
    );
    closeBtn.addEventListener("click", closeJimakuDialog);
    header.appendChild(closeBtn);

    const searchRow = makeEl("div", { display: "flex", gap: "6px" });
    const nameInput = makeEl("input", {
      flex: "1",
      minWidth: "0",
      padding: "7px 9px",
      borderRadius: "8px",
      border: "1px solid rgba(255,255,255,0.15)",
      background: "rgba(255,255,255,0.06)",
      color: "#fff",
      fontSize: "13px",
    });
    nameInput.type = "text";
    nameInput.placeholder = "Anime name";
    nameInput.value = titleGuess();
    const epInput = makeEl("input", {
      width: "56px",
      padding: "7px 6px",
      borderRadius: "8px",
      border: "1px solid rgba(255,255,255,0.15)",
      background: "rgba(255,255,255,0.06)",
      color: "#fff",
      fontSize: "13px",
    });
    epInput.type = "number";
    epInput.min = "1";
    epInput.placeholder = "Ep";
    const searchBtn = makeEl(
      "button",
      {
        padding: "7px 12px",
        borderRadius: "8px",
        border: "none",
        background: "#2878d0",
        color: "#fff",
        fontWeight: "600",
        cursor: "pointer",
      },
      "Search",
    );
    searchRow.append(nameInput, epInput, searchBtn);

    const status = makeEl("div", { opacity: "0.75", minHeight: "18px" });
    const results = makeEl("div", {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      overflowY: "auto",
    });

    const setStatus = (text) => {
      status.textContent = text;
    };
    const clearResults = () => {
      results.textContent = "";
    };

    async function doSearch() {
      const query = nameInput.value.trim();
      if (!query) {
        setStatus("Enter an anime name.");
        return;
      }
      setStatus("Searching Jimaku…");
      clearResults();
      const response = await chrome.runtime.sendMessage({
        action: "JIMAKU_SEARCH",
        query,
      });
      if (!response || !response.ok) {
        setStatus((response && response.error) || "Search failed.");
        return;
      }
      const entries = response.entries || [];
      if (!entries.length) {
        setStatus("No matches on Jimaku for that name.");
        return;
      }
      setStatus(`${entries.length} result(s) — pick the title:`);
      for (const entry of entries.slice(0, 25)) {
        const primary = entry.english_name || entry.name || `Entry ${entry.id}`;
        const secondary = entry.japanese_name ? `  ·  ${entry.japanese_name}` : "";
        const button = makeResultButton(`${primary}${secondary}`);
        button.addEventListener("click", () => loadFiles(entry));
        results.appendChild(button);
      }
    }

    async function loadFiles(entry) {
      clearResults();
      setStatus(`Loading files for “${entry.english_name || entry.name}”…`);
      const episode = Number(epInput.value) || undefined;
      let response = await chrome.runtime.sendMessage({
        action: "JIMAKU_FILES",
        entryId: entry.id,
        episode,
      });
      if (!response || !response.ok) {
        setStatus((response && response.error) || "Could not list files.");
        return;
      }
      let files = response.files || [];
      if (episode && files.length === 0) {
        // The episode filter parses numbers out of free-form filenames and often
        // misses (absolute vs per-season numbering) — fall back to all files.
        response = await chrome.runtime.sendMessage({
          action: "JIMAKU_FILES",
          entryId: entry.id,
        });
        files = response && response.ok ? response.files || [] : [];
        setStatus("No exact episode match — showing all files:");
      } else {
        setStatus(`${files.length} file(s) — pick one:`);
      }

      const usable = files.filter((file) => !/\.(zip|rar|7z)$/i.test(file.name || ""));
      clearResults();
      const back = makeResultButton("← back to results");
      back.addEventListener("click", doSearch);
      results.appendChild(back);
      if (!usable.length) {
        setStatus("No usable .srt/.ass files for this title (archives skipped).");
        return;
      }
      for (const file of usable.slice(0, 80)) {
        const button = makeResultButton(file.name);
        button.addEventListener("click", () => pickFile(file));
        results.appendChild(button);
      }
    }

    async function pickFile(file) {
      setStatus(`Downloading “${file.name}”…`);
      const response = await chrome.runtime.sendMessage({
        action: "JIMAKU_DOWNLOAD",
        url: file.url,
      });
      if (!response || !response.ok) {
        setStatus((response && response.error) || "Download failed.");
        return;
      }
      const parsed = WonderSubtitleParser.parse(
        String(response.content || ""),
        file.name,
      );
      if (!parsed.length) {
        setStatus("That file had no readable subtitles.");
        return;
      }
      applyCues(parsed);
      if (sessionCuesKey) {
        try {
          chrome.storage.session.set({ [sessionCuesKey]: parsed });
        } catch (_) {
          /* local frame still renders */
        }
      }
      closeJimakuDialog();
    }

    searchBtn.addEventListener("click", doSearch);
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        doSearch();
      }
    });

    dialog.append(header, searchRow, status, results);
    backdrop.appendChild(dialog);
    overlayParent().appendChild(backdrop);
    nameInput.focus();
    if (nameInput.value) {
      doSearch();
    }
  }

  // --- Automatic subtitle sync -------------------------------------------------
  // Normalises a line for fuzzy matching: lower-cased, whitespace removed, and
  // common Japanese + Latin punctuation stripped so ASR/subtitle punctuation
  // differences don't hurt the comparison.
  function normalizeForMatch(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[、。，．！？!?「」『』（）()【】\[\]…‥・~〜ー—\-"'`.,:;]/g, "");
  }

  function bigrams(str) {
    const grams = [];
    for (let i = 0; i < str.length - 1; i += 1) {
      grams.push(str.slice(i, i + 2));
    }
    return grams;
  }

  // Sørensen–Dice coefficient over character bigrams — robust to small ASR errors
  // and needs no word boundaries, so it works for Japanese. 1 = identical, 0 = no
  // shared bigrams.
  function diceSimilarity(a, b) {
    if (a === b) {
      return a ? 1 : 0;
    }
    if (a.length < 2 || b.length < 2) {
      return 0;
    }
    const counts = new Map();
    const aGrams = bigrams(a);
    const bGrams = bigrams(b);
    for (const g of aGrams) {
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    let matches = 0;
    for (const g of bGrams) {
      const c = counts.get(g) || 0;
      if (c > 0) {
        counts.set(g, c - 1);
        matches += 1;
      }
    }
    return (2 * matches) / (aGrams.length + bGrams.length);
  }

  // Matches transcribed audio lines against the loaded subtitles to find the offset.
  // Each transcribed segment is placed in video time (anchor + its clip-relative
  // start); the best-matching cue by text yields an offset estimate (displayed
  // cue-time = videoTime − offset, so offset = audioTime − cue.startMs). Distinctive
  // lines appear once, so the correct estimates form a tight cluster that outvotes
  // any stray mis-match — far more robust than matching speech/silence rhythm.
  function applyAutoSyncTranscript(segments) {
    if (!video || !cues.length) {
      setAutoSyncStatus("Load subtitles and play the video first.");
      return;
    }
    if (!Array.isArray(segments) || !segments.length) {
      setAutoSyncStatus("No speech was transcribed — try again over dialogue.");
      return;
    }
    if (autosyncAnchorMs == null) {
      setAutoSyncStatus("Missing the capture anchor — try the sync again.");
      return;
    }

    const normCues = cues.map((cue) => normalizeForMatch(cue.text));
    const MIN_SIMILARITY = 0.5;
    const estimates = [];
    for (const segment of segments) {
      const segText = normalizeForMatch(segment.text);
      if (segText.length < 2) {
        continue;
      }
      let bestSim = 0;
      let bestIdx = -1;
      for (let i = 0; i < normCues.length; i += 1) {
        const sim = diceSimilarity(segText, normCues[i]);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && bestSim >= MIN_SIMILARITY) {
        const absAudioMs = autosyncAnchorMs + (Number(segment.startMs) || 0);
        estimates.push(absAudioMs - cues[bestIdx].startMs);
      }
    }

    if (estimates.length < 2) {
      setAutoSyncStatus(
        "Low confidence — try again over dialogue (works best with Japanese subtitles).",
      );
      return;
    }

    // Largest cluster within a tight window, then its median — ignores outliers
    // from segments that merged lines or mis-matched.
    const CLUSTER_MS = 400;
    const sorted = estimates.slice().sort((a, b) => a - b);
    let best = { count: 0, values: [] };
    for (let i = 0; i < sorted.length; i += 1) {
      const group = [];
      for (
        let j = i;
        j < sorted.length && sorted[j] - sorted[i] <= CLUSTER_MS;
        j += 1
      ) {
        group.push(sorted[j]);
      }
      if (group.length > best.count) {
        best = { count: group.length, values: group };
      }
    }

    if (best.count < 2) {
      setAutoSyncStatus(
        "Low confidence — the lines didn't line up. Try again over dialogue.",
      );
      return;
    }

    const median = best.values[Math.floor(best.values.length / 2)];
    setOffset(Math.round(median));
    const seconds = (offsetMs / 1000).toFixed(1);
    setAutoSyncStatus(
      `Auto-synced to ${offsetMs >= 0 ? "+" : ""}${seconds}s ` +
        `(${best.count}/${estimates.length} lines agreed).`,
    );
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  // Snaps the offset so the clicked line is shown at the current video time. The
  // cue's own timestamp is the ground truth, so one click gives an exact sync.
  function manualSyncTo(cueStartMs, label) {
    if (!video) {
      setAutoSyncStatus("Play the video first.");
      return;
    }
    setOffset(Math.round(video.currentTime * 1000 - cueStartMs));
    const line = String(label || "").replace(/\s+/g, " ").trim();
    setAutoSyncStatus(
      `Synced to: ${line.length > 28 ? `${line.slice(0, 28)}…` : line}`,
    );
  }

  // (Re)builds the manual cue list inside the dialog, optionally filtered. Rows wrap
  // and use a readable size; capped so a long file can't render thousands at once.
  function renderManualCueList(filter) {
    if (!manualListEl) {
      return;
    }
    manualListEl.textContent = "";
    const query = normalizeForMatch(filter || "");
    let shown = 0;
    for (let i = 0; i < cues.length && shown < 300; i += 1) {
      const cue = cues[i];
      if (query && !normalizeForMatch(cue.text).includes(query)) {
        continue;
      }
      const row = makeEl("button", {
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        borderRadius: "8px",
        border: "none",
        background: "rgba(255, 255, 255, 0.08)",
        color: "#fff",
        cursor: "pointer",
      });
      row.append(
        makeEl(
          "div",
          { opacity: "0.5", fontSize: "11px", marginBottom: "3px" },
          formatClock(cue.startMs),
        ),
        makeEl(
          "div",
          {
            fontSize: "15px",
            lineHeight: "1.45",
            whiteSpace: "normal",
            wordBreak: "break-word",
          },
          cue.text,
        ),
      );
      const startMs = cue.startMs;
      const label = cue.text;
      row.addEventListener("click", () => {
        manualSyncTo(startMs, label);
        closeManualSyncDialog();
      });
      manualListEl.appendChild(row);
      shown += 1;
    }
    if (!shown) {
      manualListEl.appendChild(
        makeEl(
          "div",
          { opacity: "0.5", fontSize: "13px", padding: "6px 2px" },
          cues.length ? "No matching line." : "Load subtitles first.",
        ),
      );
    }
  }

  function closeManualSyncDialog() {
    if (manualDialogEl && manualDialogEl.isConnected) {
      manualDialogEl.remove();
    }
    manualDialogEl = null;
    manualListEl = null;
    manualSearchEl = null;
  }

  // A full modal (mirrors the Jimaku dialog) so lines are actually readable — the
  // 230px control panel was too cramped. Search to jump to the line you hear, then
  // click it for an exact one-click sync.
  function openManualSyncDialog() {
    closeManualSyncDialog();

    const backdrop = makeEl("div", {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0, 0, 0, 0.5)",
      pointerEvents: "auto",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });
    manualDialogEl = backdrop;
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        closeManualSyncDialog();
      }
    });

    const dialog = makeEl("div", {
      width: "480px",
      maxWidth: "92vw",
      maxHeight: "80vh",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      padding: "16px",
      background: "rgba(20, 20, 23, 0.98)",
      color: "#fff",
      borderRadius: "12px",
      boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
      fontSize: "13px",
    });

    const header = makeEl("div", {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    });
    header.appendChild(makeEl("strong", null, "Sync to a line"));
    const closeBtn = makeEl(
      "button",
      {
        border: "none",
        background: "none",
        color: "#fff",
        fontSize: "18px",
        cursor: "pointer",
        lineHeight: "1",
      },
      "✕",
    );
    closeBtn.addEventListener("click", closeManualSyncDialog);
    header.appendChild(closeBtn);

    dialog.appendChild(header);
    dialog.appendChild(
      makeEl(
        "span",
        { opacity: "0.6", fontSize: "12px" },
        "Click the line being spoken right now — the subtitles snap to it.",
      ),
    );

    manualSearchEl = makeEl("input", {
      padding: "8px 10px",
      borderRadius: "8px",
      border: "1px solid rgba(255,255,255,0.15)",
      background: "rgba(255,255,255,0.06)",
      color: "#fff",
      fontSize: "14px",
    });
    manualSearchEl.type = "text";
    manualSearchEl.placeholder = "Search the lines…";
    manualSearchEl.addEventListener("input", () =>
      renderManualCueList(manualSearchEl.value),
    );
    dialog.appendChild(manualSearchEl);

    manualListEl = makeEl("div", {
      flex: "1",
      minHeight: "0",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });
    dialog.appendChild(manualListEl);

    backdrop.appendChild(dialog);
    overlayParent().appendChild(backdrop);
    renderManualCueList("");
    manualSearchEl.focus();
  }

  // Fullscreen puts the video in a top layer that hides ordinary fixed elements,
  // so host the overlay inside the fullscreen element when there is one. A bare
  // <video> can't hold children, so fall back to its parent (works when the site
  // fullscreens a container — the common case for custom players).
  function overlayParent() {
    const fs = document.fullscreenElement;
    if (fs) {
      if (fs.tagName === "VIDEO") {
        return fs.parentElement || document.body || document.documentElement;
      }
      return fs;
    }
    return document.body || document.documentElement;
  }

  function removeOverlay() {
    stopRendering();
    if (overlayEl && overlayEl.isConnected) {
      overlayEl.remove();
    }
    overlayEl = null;
    textEl = null;
    activeIndex = -1;
  }

  function removeControlPanel() {
    if (panelEl && panelEl.isConnected) {
      panelEl.remove();
    }
    panelEl = null;
    sizeInputEl = null;
    colorInputEl = null;
    offsetInputEl = null;
    jimakuButtonEl = null;
    autoSyncStatusEl = null;
  }

  function reparentOverlay() {
    const parent = overlayParent();
    if (overlayEl) {
      parent.appendChild(overlayEl);
    }
    if (panelEl) {
      parent.appendChild(panelEl);
    }
  }

  // --- Sync loop ---------------------------------------------------------------
  function cueIndexAt(timeMs) {
    // Cues are start-sorted and generally non-overlapping; a linear scan is fine
    // for a single episode's worth of lines.
    for (let i = 0; i < cues.length; i += 1) {
      if (timeMs < cues[i].startMs) {
        break;
      }
      if (timeMs < cues[i].endMs) {
        return i;
      }
    }
    return -1;
  }

  function cueActiveAt(timeMs) {
    for (let i = 0; i < cues.length; i += 1) {
      if (timeMs < cues[i].startMs) {
        return false;
      }
      if (timeMs < cues[i].endMs) {
        return true;
      }
    }
    return false;
  }

  function renderFrame() {
    rafHandle = requestAnimationFrame(renderFrame);

    if (!video || !video.isConnected) {
      // Re-detect (the player can swap its <video> on SPA nav), but throttle the
      // DOM walk so a frame that has lost its video doesn't scan every frame.
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastRescanAt < 500) {
        return;
      }
      lastRescanAt = now;
      video = pickActiveVideo();
      if (!video) {
        return;
      }
      ensureControlPanel();
    }
    if (!cues.length) {
      return;
    }

    ensureOverlay();
    const timeMs = video.currentTime * 1000 - offsetMs;
    const index = cueIndexAt(timeMs);
    if (index === activeIndex) {
      return;
    }
    activeIndex = index;
    if (index >= 0) {
      textEl.textContent = cues[index].text;
      overlayEl.style.opacity = "1";
    } else {
      overlayEl.style.opacity = "0";
    }
  }

  function startRendering() {
    if (rafHandle === null) {
      rafHandle = requestAnimationFrame(renderFrame);
    }
  }

  function stopRendering() {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  function applyCues(nextCues) {
    cues = Array.isArray(nextCues) ? nextCues : [];
    activeIndex = -1;
    if (manualListEl && manualListEl.isConnected) {
      renderManualCueList(manualSearchEl ? manualSearchEl.value : "");
    }
    if (!enabled) {
      return; // disabled: teardown() has already cleared the overlay
    }
    if (!cues.length) {
      removeOverlay();
      return;
    }
    // Only spin the render loop in a frame that actually has the video; other
    // frames (top page, ads) just hold the cues. The player frame starts here if
    // its video is already known, otherwise from the video poll.
    if (video) {
      startRendering();
    }
  }

  // --- Drag & drop subtitle loading -------------------------------------------
  function dragHasFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return Boolean(types) && Array.prototype.indexOf.call(types, "Files") !== -1;
  }

  function onDragOver(event) {
    if (enabled && dragHasFiles(event)) {
      event.preventDefault(); // allow the drop instead of the browser navigating
    }
  }

  function onDrop(event) {
    if (!enabled) {
      return;
    }
    const file =
      event.dataTransfer &&
      event.dataTransfer.files &&
      event.dataTransfer.files[0];
    if (!file || !/\.(srt|vtt|ass|ssa)$/i.test(file.name)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const reader = new FileReader();
    reader.onload = () => {
      const parsed = WonderSubtitleParser.parse(
        String(reader.result || ""),
        file.name,
      );
      if (!parsed.length) {
        return;
      }
      applyCues(parsed);
      // Share with the other frames of THIS tab (the player iframe renders even
      // when the drop landed on the top page).
      if (sessionCuesKey) {
        try {
          chrome.storage.session.set({ [sessionCuesKey]: parsed });
        } catch (_) {
          // access level not set yet / storage unavailable — local frame still shows it
        }
      }
    };
    reader.readAsText(file);
  }

  // --- Offset nudge (temporary keyboard control for verifying sync) -----------
  function onKeydown(event) {
    if (!enabled || !cues.length || !event.shiftKey) {
      return;
    }
    const target = event.target;
    const tag = (target && target.tagName ? target.tagName : "").toLowerCase();
    if (tag === "input" || tag === "textarea" || (target && target.isContentEditable)) {
      return;
    }
    if (event.key === "ArrowLeft") {
      setOffset(offsetMs - OFFSET_STEP_MS);
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      setOffset(offsetMs + OFFSET_STEP_MS);
      event.preventDefault();
    }
  }

  function setOffset(nextMs) {
    offsetMs = nextMs;
    activeIndex = -1; // force a re-render at the new offset
    updateOffsetReadout();
    persistAppearance();
  }

  // --- Storage reactivity ------------------------------------------------------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && sessionCuesKey && changes[sessionCuesKey]) {
      applyCues(changes[sessionCuesKey].newValue || []);
    }
    if (area === "local" && changes[SETTINGS_KEY]) {
      // Appearance only — activation is per-site and arrives via the
      // "subtitle-active" message, not through this global settings blob.
      const next = changes[SETTINGS_KEY].newValue || {};
      offsetMs = Number(next.offsetMs || 0);
      if (next.fontSizePx) {
        fontSizePx = Number(next.fontSizePx);
      }
      if (next.textColor) {
        textColor = String(next.textColor);
      }
      activeIndex = -1;
      syncControls();
    }
  });

  // --- Init --------------------------------------------------------------------
  async function resolveTabId() {
    try {
      const response = await chrome.runtime.sendMessage({ action: "GET_TAB_ID" });
      const tabId = response && response.ok ? response.tabId : null;
      if (typeof tabId === "number") {
        sessionCuesKey = `${SESSION_CUES_PREFIX}${tabId}`;
      }
      if (response && response.title) {
        tabTitle = String(response.title);
      }
      // The background resolves the tab's top-level host and tells us whether the
      // user opted this site in — the only thing that activates the overlay.
      siteActive = Boolean(response && response.active);
    } catch (_) {
      sessionCuesKey = null; // no cross-frame sharing, but the drop frame still renders
    }
  }

  function loadInitialState() {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (result) => {
        const settings = (result && result[SETTINGS_KEY]) || {};
        // Activation is per-site, resolved by the background (see resolveTabId);
        // storage only carries appearance here.
        enabled = siteActive;
        offsetMs = Number(settings.offsetMs || 0);
        if (settings.fontSizePx) {
          fontSizePx = Number(settings.fontSizePx);
        }
        if (settings.textColor) {
          textColor = String(settings.textColor);
        }
        syncControls();
        applyEnabledState();
      });
    } catch (_) {
      /* storage unavailable in this frame */
    }
  }

  // Activates (video watch + panel + cue render) or fully tears down, per the
  // Watch & Mine toggle. Called after settings load and on every toggle.
  function applyEnabledState() {
    if (enabled) {
      startVideoWatch();
      loadSessionCues();
    } else {
      teardown();
    }
  }

  // The player <video> (blob/MSE) often appears after load, so keep looking for a
  // short while if it is not here yet. Once found, show the panel and (if cues are
  // loaded) render.
  function startVideoWatch() {
    video = pickActiveVideo();
    if (video) {
      onVideoFound();
      return;
    }
    if (videoPollTimer !== null) {
      return;
    }
    let attempts = 0;
    videoPollTimer = setInterval(() => {
      attempts += 1;
      video = pickActiveVideo();
      if (video || attempts > 20 || !enabled) {
        clearInterval(videoPollTimer);
        videoPollTimer = null;
        if (video && enabled) {
          onVideoFound();
        }
      }
    }, 1000);
  }

  function loadSessionCues() {
    if (!sessionCuesKey) {
      return;
    }
    try {
      chrome.storage.session.get(sessionCuesKey, (result) => {
        const stored = result && result[sessionCuesKey];
        if (Array.isArray(stored) && stored.length) {
          applyCues(stored);
        }
      });
    } catch (_) {
      /* storage unavailable in this frame */
    }
  }

  function teardown() {
    if (videoPollTimer !== null) {
      clearInterval(videoPollTimer);
      videoPollTimer = null;
    }
    removeOverlay();
    removeControlPanel();
    closeJimakuDialog();
    cues = [];
  }

  // The panel belongs in a frame that has the video; showing it also lets the
  // user load subtitles (drop hint / Jimaku) before any cues exist.
  function onVideoFound() {
    ensureControlPanel();
    if (cues.length) {
      startRendering();
    }
  }

  async function init() {
    // Drop/keydown are attached in every frame (cheap) so a subtitle can be
    // dropped anywhere; rendering only happens where a video is present and the
    // feature is enabled.
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("keydown", onKeydown, true);
    document.addEventListener("fullscreenchange", reparentOverlay, true);

    await resolveTabId();
    loadInitialState();
  }

  init();
})();
