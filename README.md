# Browser Wonder of U

Chrome extension for recording tab audio, saving it locally, transcribing it with a local `whisper.cpp` native host, and creating Anki cards through AnkiConnect.

## Features

- Records the current tab audio and saves it locally.
- Transcribes saved recordings with a local `whisper-cli` runtime.
- Saves the transcript as a `.txt` file beside the recording.
- Lets users choose the final output folder for saved audio and transcripts.
- Queues Anki cards locally and lets the user push them manually from the popup.
- Optionally sends the transcript through `https://translate.google.com` and adds the translated text to the same Anki back field when capture succeeds.
- Preserves transcript line breaks and spacing in the Anki back field so cards match the saved `.txt` transcript.
- Lets users inspect queued recordings in the popup and drop individual cards before they are pushed.
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
3. Optionally choose a custom output folder for recordings and transcripts.
4. Use the `Browse` buttons to select your local `whisper-cli.exe` and Whisper model `.bin` file.
5. Set the language you want, or leave it at `auto`.
6. Enter the Anki deck name you want to use.
7. Optionally turn on `Capture Google Translate output` and grant Chrome access to `translate.google.com` when prompted.

### Runtime Notes

- The extension always saves the audio first.
- Audio is staged through Chrome downloads, then moved into your chosen output folder when one is configured.
- If the export format is not WAV, it creates a temporary WAV file only for transcription.
- After transcription completes, the card is queued locally even when Anki is online. Use the popup to push queued cards when you are ready.
- If the configured deck name does not exist in Anki, transcript saving still succeeds and card creation returns a simple deck-name error.
- If translation is enabled, the extension opens or reuses `https://translate.google.com`, pastes the transcript, waits for the page result, and includes that translation in Anki when capture succeeds.
- If Google Translate cannot be read, permission is missing, or the page does not finish translating in time, the extension falls back to the existing transcript-only Anki behavior.
- Google Translate language selection is currently whatever the website is already set to use in that tab.
- The path picker is implemented through the Windows native host, so that browse flow is currently Windows-only.
