"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

const stored = { ankiSettings: undefined };

const context = vm.createContext({
  console,
  URL,
  chrome: {
    storage: {
      local: {
        get: async (key) => ({ [key]: stored[key] }),
        set: async (values) => Object.assign(stored, values),
      },
    },
  },
});
context.self = context;

vm.runInContext(
  fs.readFileSync(path.join(projectRoot, "utils.js"), "utf8"),
  context,
  { filename: "utils.js" },
);

const evaluate = (expression) => vm.runInContext(expression, context);

async function run() {
  // The defaults must reproduce what the extension did before mapping existed —
  // audio on the front, transcript on the back of a Basic note — so an existing
  // install keeps making the same cards until the user changes something.
  const defaults = evaluate("normalizeAnkiSettings(undefined)");
  assert.equal(defaults.noteType, "Basic");
  assert.equal(defaults.fields.audio, "Front");
  assert.equal(defaults.fields.transcription, "Back");
  assert.equal(defaults.fields.translation, "");
  assert.equal(defaults.fields.sourcePath, "");
  assert.equal(defaults.fields.createdAt, "");

  // Every role the UI offers must survive a round trip through storage.
  const roles = evaluate("ANKI_FIELD_ROLES.map((role) => role.key)");
  assert.deepEqual(
    [...roles].sort(),
    ["audio", "createdAt", "sourcePath", "transcription", "translation"],
  );

  // A blank mapping is a real choice ("do not fill this field"), not a missing
  // value to be replaced with the default — otherwise a role could never be unset.
  const cleared = evaluate(
    'normalizeAnkiSettings({ noteType: "Immersion", fields: { audio: "", transcription: "Expression", translation: "Meaning" } })',
  );
  assert.equal(cleared.noteType, "Immersion");
  assert.equal(cleared.fields.audio, "", "an explicitly unmapped role stays unmapped");
  assert.equal(cleared.fields.transcription, "Expression");
  assert.equal(cleared.fields.translation, "Meaning");

  // A note type of nothing falls back rather than producing a note Anki rejects.
  assert.equal(evaluate('normalizeAnkiSettings({ noteType: "   " }).noteType'), "Basic");

  // Persisting one role must not wipe the others.
  stored.ankiSettings = undefined;
  await evaluate('updateAnkiSettings({ fields: { translation: "Meaning" } })');
  const saved = await evaluate("getAnkiSettings()");
  assert.equal(saved.fields.translation, "Meaning");
  assert.equal(
    saved.fields.transcription,
    "Back",
    "changing one role must not reset the rest of the mapping",
  );

  // Switching note type clears the mapping, because field names do not carry over.
  await evaluate(
    'updateAnkiSettings({ noteType: "Immersion", fields: { audio: "", transcription: "", translation: "", sourcePath: "", createdAt: "" } })',
  );
  const switched = await evaluate("getAnkiSettings()");
  assert.equal(switched.noteType, "Immersion");
  assert.deepEqual(
    Object.values(switched.fields).filter(Boolean),
    [],
    "a note type switch must leave no stale field names behind",
  );

  console.log("Anki mapping tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
