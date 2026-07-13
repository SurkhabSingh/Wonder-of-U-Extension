# Wonder of U — Browser Extension

A Chrome extension for turning what you watch and listen to in the browser into
Anki cards: it records tab audio, transcribes it locally with `whisper.cpp`,
translates it, and queues the card for Anki.

It works on its own, and it also acts as the browser half of the
[Wonder of U desktop app](../desktop-app). Those are the two modes below.

## The Two Modes

The first time you open the popup it asks which one you want. You can change it
later from the mode chip in the header.

### Solo — the extension does everything

Everything happens in the browser and on your machine. Nothing else needs to be
installed except the native host (below) and, optionally, Anki.

- Records the current tab's audio and saves it locally.
- Transcribes it with your local `whisper-cli` and Whisper model.
- Saves the transcript as a `.txt` beside the recording.
- Optionally translates the transcript with Google Translate or DeepL.
- Maps the audio, transcript, and translation onto the Anki fields you choose,
  then queues the card so you can push it when you are ready.

This is the standalone product. If you never install the desktop app, this is all
you need.

### App Support — the extension serves the desktop app

The desktop app records system audio (not just a browser tab), transcribes, and
manages a recording library. The one thing it cannot do is drive a website — so
in this mode the extension becomes its **translation worker**: the app sends a
transcript, the extension translates it in the browser, and sends the result back.

The two complement each other:

| | Solo | App Support |
| --- | --- | --- |
| Records | the browser tab | any system audio (the app does it) |
| Transcribes | in the extension | in the app |
| Translates | in the extension | in the extension, for the app |
| Anki cards | queued by the extension | pushed by the app |

You do not need App Support mode to use the desktop app — translation is optional
and non-blocking. But with it, the app's **Translate** action works.

Leave the browser open in this mode. It can stay minimized.

## Setup

### Requirements

- Google Chrome (116 or newer), with Developer mode enabled for unpacked extensions.
- A local `whisper.cpp` runtime, including `whisper-cli` — for Solo mode only.
- A local Whisper model such as `ggml-large-v3.bin` — for Solo mode only.
- Anki with AnkiConnect on `http://127.0.0.1:8765`, if you want cards.

### 1. Load the extension

Load this folder as an unpacked extension in `chrome://extensions`, then copy the
extension ID Chrome shows you.

### 2. Install the native host

The native host is a small local Node process. It is **required for both modes**:
Solo uses it to run Whisper and talk to Anki, and App Support uses it to hold the
connection to the desktop app.

```powershell
powershell -ExecutionPolicy Bypass -File .\install-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID
```

or:

```bat
install-native-host.cmd YOUR_EXTENSION_ID
```

This writes `native-host-manifest.json` with your extension ID and registers the
host with Chrome. The generated manifest stays local and is gitignored.

If you reload the extension and Chrome gives it a new ID, run this again.

### 3. Configure the popup

**For Solo mode:**

1. Turn on `Transcribe after save`.
2. Browse for your `whisper-cli.exe` and your Whisper model `.bin`.
3. Choose the transcription language, or leave it on `auto`.
4. Pick the Anki deck.
5. Under **Anki Mapping**, pick the note type and choose which field gets the
   audio, the transcript, and the translation. The defaults (`Front` = audio,
   `Back` = transcript, on a `Basic` note) match what the extension did before
   mapping existed, so you can leave them alone if they suit you.
6. Optionally turn on `Capture translation output`, pick the provider and the
   language to translate into, and grant access to that provider when prompted.

**For App Support mode:**

1. Choose App Support. Chrome will ask for permission to reach `127.0.0.1` and
   the translation provider — both are required.
2. Start the desktop app. The popup should read **Connected**.

## Translation

Two providers are supported, and they behave differently. This is worth
understanding, because it is the difference between "reliable" and "usually works".

### DeepL with an API key — the reliable path

Paste a DeepL API key in the popup and DeepL is translated over its official API.
No tab is opened, nothing is scraped, and it keeps working with the browser
minimized. If translation matters to you, use this.

Free DeepL keys end in `:fx` and are routed to `api-free.deepl.com` automatically.

### Website-driven translation — the best-effort path

Without a key, the extension drives the provider's website in a throwaway
background tab: it loads the page with the transcript already in the URL, reads
the result, and closes the tab. Long transcripts are split into chunks and
reassembled, since provider sites silently truncate past their input cap.

This works, including while the browser is minimized, but it depends on Chrome
being willing to run a hidden tab — and Chrome throttles hidden tabs aggressively.
The extension installs a small page helper to work around the worst of it (Google
in particular will not render its result in a hidden tab without it). If a
provider cannot be read, the card is still created from the transcript alone.

## Runtime Notes

- The audio is always saved first. Nothing else can lose it.
- Audio is staged through Chrome's downloads, then moved into your chosen output
  folder if you set one.
- If the export format is not WAV, a temporary WAV is created just for Whisper.
- Cards are queued locally even when Anki is running. Push them from the popup
  when you want to.
- If a role is left unmapped in the Anki mapping, that field is skipped entirely
  rather than written blank, so it cannot overwrite something you fill in
  yourself. If there is a translation but no field mapped for it, it is appended
  to the transcript rather than thrown away.
- The folder/file pickers go through the native host, so that flow is currently
  Windows-only.

## Development

```powershell
node tests/translation-modules.test.js
node tests/native-bridge.test.js
node tests/anki-mapping.test.js
node tests/browser-tab-capture-provider.test.js
```

`translation/BRIDGE.md` documents the contract between the extension and any app
that wants to use it as a translation worker, and explains why the connection runs
over a native messaging port rather than HTTP.
