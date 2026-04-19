# Browser Wonder of U

Chrome extension for recording tab audio, saving it locally, transcribing it with a local `whisper.cpp` native host, and creating Anki cards through AnkiConnect.

## Features

- Records the current tab audio and saves it locally.
- Transcribes saved recordings with a local `whisper-cli` runtime.
- Saves the transcript as a `.txt` file beside the recording.
- Creates an Anki card in deck `Audio Immersion` when AnkiConnect is available.
- Preserves transcript line breaks and spacing in the Anki back field so cards match the saved `.txt` transcript.
- Queues card creation locally when Anki is offline.
- Lets users browse for the local `whisper-cli` executable and Whisper model from the popup instead of pasting paths manually.

## Setup

### Requirements

- Google Chrome with Developer mode enabled for unpacked extensions.
- A local `whisper.cpp` runtime, including `whisper-cli`.
- A local Whisper model such as `ggml-large-v3.bin`.
- Anki with AnkiConnect on `http://127.0.0.1:8765` if you want card creation.

### Install the Native Host

1. Load this folder as an unpacked extension in `chrome://extensions`.
2. Copy the extension ID shown by Chrome.
3. Run the installer from this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID
```

You can also use:

```bat
install-native-host.cmd YOUR_EXTENSION_ID
```

The installer generates `native-host-manifest.json` locally with your actual extension ID and registers the native host for Chrome. The generated manifest is intended to stay local and is ignored by `.gitignore`.

### Configure the Popup

1. Open the extension popup.
2. Turn on `Transcribe after save`.
3. Use the `Browse` buttons to select your local `whisper-cli.exe` and Whisper model `.bin` file.
4. Set the language you want, or leave it at `auto`.

### Runtime Notes

- The extension always saves the audio first.
- If the export format is not WAV, it creates a temporary WAV file only for transcription.
- If Anki is unavailable, the transcript still saves and the card is queued locally.
- The path picker is implemented through the Windows native host, so that browse flow is currently Windows-only.
