// SubRip (.srt) / WebVTT (.vtt) / Advanced SubStation Alpha (.ass) parser for the
// subtitle-mining overlay. Runs in the overlay content script's ISOLATED world;
// exposes a single global. Dependency-free and tolerant: unknown lines, BOMs,
// CRLF, and inline markup are handled, and anything unparseable is skipped.
// `.ass` support matters because much of the Jimaku corpus is ASS-only.
(function (globalScope) {
  "use strict";

  // Hours are optional (VTT allows MM:SS.mmm); the fraction separator is `,`
  // (SRT) or `.` (VTT/ASS), and the fraction is read as a fraction of a second so
  // 1-, 2-, or 3-digit values all map correctly (",5" = 500ms, ".05" = 50ms,
  // ASS centiseconds ".50" = 500ms).
  const TIMESTAMP = /(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

  function toMs(hours, minutes, seconds, fraction) {
    const fractionMs = Math.round(Number(`0.${fraction}`) * 1000);
    return (
      Number(hours || 0) * 3600000 +
      Number(minutes) * 60000 +
      Number(seconds) * 1000 +
      fractionMs
    );
  }

  function normalize(raw) {
    return raw
      .replace(/^﻿/, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }

  // ---- SRT / VTT -------------------------------------------------------------
  function parseTimingLine(line) {
    const halves = line.split("-->");
    if (halves.length !== 2) {
      return null;
    }
    const start = TIMESTAMP.exec(halves[0]);
    const end = TIMESTAMP.exec(halves[1]);
    if (!start || !end) {
      return null;
    }
    return {
      startMs: toMs(start[1], start[2], start[3], start[4]),
      endMs: toMs(end[1], end[2], end[3], end[4]),
    };
  }

  // Strips SRT/VTT inline markup (<i>, <b>, <c.class>) and ASS-style override
  // blocks ({\an8}) so the mined text is clean. Collapses the remaining lines.
  function cleanText(text) {
    return text
      .replace(/<[^>]*>/g, "")
      .replace(/\{[^}]*\}/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  function parseSrtVtt(raw) {
    const cues = [];
    for (const block of normalize(raw).split(/\n\s*\n/)) {
      const lines = block.split("\n").filter((line) => line.trim() !== "");
      if (lines.length === 0) {
        continue;
      }

      // Skip a leading numeric index or the WEBVTT/NOTE/STYLE headers, then find
      // the timing line; everything after it is the cue body.
      let timing = null;
      let bodyStart = 0;
      for (let i = 0; i < lines.length; i += 1) {
        timing = parseTimingLine(lines[i]);
        if (timing) {
          bodyStart = i + 1;
          break;
        }
      }
      if (!timing || timing.endMs <= timing.startMs) {
        continue;
      }

      const body = cleanText(lines.slice(bodyStart).join("\n"));
      if (body) {
        cues.push({ startMs: timing.startMs, endMs: timing.endMs, text: body });
      }
    }

    cues.sort((a, b) => a.startMs - b.startMs);
    return cues;
  }

  // ---- ASS / SSA -------------------------------------------------------------
  function assTimeToMs(value) {
    const match = /(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/.exec(String(value).trim());
    if (!match) {
      return null;
    }
    return toMs(match[1], match[2], match[3], match[4]);
  }

  // Splits a Dialogue body into exactly `count` fields; the last field keeps any
  // remaining commas, because ASS puts Text last and it commonly contains commas.
  function splitAssFields(body, count) {
    const parts = [];
    let rest = body;
    for (let i = 0; i < count - 1; i += 1) {
      const comma = rest.indexOf(",");
      if (comma === -1) {
        parts.push(rest);
        rest = "";
      } else {
        parts.push(rest.slice(0, comma));
        rest = rest.slice(comma + 1);
      }
    }
    parts.push(rest);
    return parts;
  }

  function cleanAssText(text) {
    return text
      .replace(/\{[^}]*\}/g, "") // {\an8}, {\i1}, karaoke, etc.
      .replace(/\\[Nn]/g, "\n") // hard/soft line breaks
      .replace(/\\h/g, " ") // hard space
      .trim();
  }

  function parseAss(raw) {
    const cues = [];
    let inEvents = false;
    let format = null; // lowercased field names from the Events "Format:" line

    for (const line of normalize(raw).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        inEvents = /^\[events\]/i.test(trimmed);
        continue;
      }
      if (!inEvents || trimmed === "") {
        continue;
      }

      if (/^format\s*:/i.test(trimmed)) {
        format = trimmed
          .slice(trimmed.indexOf(":") + 1)
          .split(",")
          .map((name) => name.trim().toLowerCase());
        continue;
      }

      if (/^dialogue\s*:/i.test(trimmed) && format) {
        const startIdx = format.indexOf("start");
        const endIdx = format.indexOf("end");
        const textIdx = format.indexOf("text");
        if (startIdx === -1 || endIdx === -1 || textIdx === -1) {
          continue;
        }

        const fields = splitAssFields(
          trimmed.slice(trimmed.indexOf(":") + 1),
          format.length,
        );
        const startMs = assTimeToMs(fields[startIdx]);
        const endMs = assTimeToMs(fields[endIdx]);
        const text = cleanAssText(fields[textIdx] || "");
        if (startMs != null && endMs != null && endMs > startMs && text) {
          cues.push({ startMs, endMs, text });
        }
      }
    }

    cues.sort((a, b) => a.startMs - b.startMs);
    return cues;
  }

  // ---- Dispatcher ------------------------------------------------------------
  function looksLikeAss(raw, name) {
    if (/\.(ass|ssa)$/i.test(name || "")) {
      return true;
    }
    return /^\s*\[script info\]/im.test(raw) || /^\s*\[events\]/im.test(raw);
  }

  // `name` (a filename) is optional; it disambiguates when the content sniff is
  // ambiguous. Falls back to SRT/VTT.
  function parse(raw, name) {
    if (typeof raw !== "string" || raw.length === 0) {
      return [];
    }
    return looksLikeAss(raw, name) ? parseAss(raw) : parseSrtVtt(raw);
  }

  globalScope.WonderSubtitleParser = Object.freeze({ parse });
})(self);
