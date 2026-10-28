# HumanVoice Studio 🎙️
### Browser Text-to-Speech Voice Modulator with Prosody Engineering

HumanVoice Studio is a modern, single-page web app built with vanilla HTML, CSS, and modern JavaScript (ES Modules). It uses the browser's native **Web Speech API (`window.speechSynthesis`)** and simulates natural human emotion, inflection, and cadence using **Prosody Engineering**.

---

## 🚀 How to Run

No build step, dependencies, or API keys required!

### Option 1: Direct File Opening
Double-click `index.html` or open it directly in Google Chrome, Microsoft Edge, Safari, or Firefox.

### Option 2: Local Web Server (Recommended)
Running through a local server ensures consistent module loading and audio recording permissions:
```bash
# Using Python 3:
python -m http.server 8080

# Or with Node npx:
npx serve .
```
Then open [http://localhost:8080](http://localhost:8080) in your browser.

---

## 🧠 Architecture & File Structure

```
├── index.html       # Clean, accessible semantic single-page layout
├── styles.css       # Responsive design system, dark/light theme, glassmorphism, visualizer styling
├── app.js           # Core playback state machine, queue coordinator, shortcut manager
├── voices.js        # Voice discovery, categorization, language filtering, online/local & cloud voice detection
├── prosody.js       # ProsodyEngine: sentence/phrase chunker, inline markup parser, prosody curve calculation
├── presets.js       # 12 expressive emotion & tone presets with custom preset persistence
├── storage.js       # LocalStorage manager for settings, custom presets, and JSON export/import
├── ui.js            # Sliders, live Prosody Graph canvas, animated waveform visualizer, tab audio recorder
└── README.md        # Documentation, browser quirks, and limitations guide
```

---

## 🔍 Browser Capabilities & Honest Technical Limitations

### What Really Works (SpeechSynthesis API)
* **`voice`**: Change speaker voice to any installed system or browser cloud voice.
* **`pitch` (0.0 to 2.0)**: Shifts base frequency up or down (1.0 = normal).
* **`rate` (0.1 to 10.0, practical 0.5 to 2.0)**: Controls speed of speaking.
* **`volume` (0.0 to 1.0)**: Master output volume.
* **`boundary` event**: Used to highlight active words and sentences during playback.

### What the Web Speech API Cannot Do (And How We Engineer Around It)
| Theoretical Feature | Browser Reality | How HumanVoice Studio Solves It |
| :--- | :--- | :--- |
| **Formants / Breathiness / EQ** | Not exposed by browser API. Raw audio stream cannot be intercepted directly. | **No fake sliders.** Instead, we use **Prosody Engineering**: coordinated pitch curves, speech rate pacing, declination, and micro-pauses. |
| **Natural Emotion** | Standard utterances sound flat and robotic. | **Sentence-level inflection curves**: Questions (`?`) automatically rise in pitch; exclamations (`!`) boost pitch, rate, and volume; ellipses (`…`) slow down with extended silence; sentences feature natural pitch declination. |
| **Chrome 15-Second Cutoff** | Chrome has a known bug where utterances lasting >15s abruptly stop without an `end` event. | Text is automatically chunked into natural sentence/phrase boundaries (1–4 seconds each) and played in a robust sequential queue. |
| **Chrome Pause/Resume Bug** | `speechSynthesis.resume()` often fails or hangs if paused for more than a few seconds in Chrome. | Sequential queue tracks exact chunk index and restarts seamlessly from the paused chunk rather than relying on browser native resume. |
| **Cloud Voices Pitch/Rate Immunity** | Certain Chrome cloud voices (e.g. "Google US English") ignore pitch and rate modulation entirely. | `voices.js` automatically detects these cloud voices and displays a helpful warning badge recommending a local or natural voice. |
| **Direct Audio File Export** | Browsers forbid direct `.wav`/`.mp3` recording of `speechSynthesis` due to cross-origin media sandboxing. | We provide an honest **"Record via Tab Audio"** tool using `navigator.mediaDevices.getDisplayMedia({ audio: true })` + `MediaRecorder` to cleanly capture and export a `.webm` audio recording. |

---

## 🌟 Tips for the Best Natural Voices

1. **Microsoft Edge (Best Experience)**:
   - Microsoft Edge provides free, world-class **"Microsoft Natural Voices"** (e.g., *Microsoft Jenny Online (Natural)*, *Microsoft Guy Online (Natural)*). These sound indistinguishable from premium cloud APIs and respond dynamically to speed and pauses!
2. **Apple Safari / macOS / iOS**:
   - macOS and iOS provide **Siri Voices** (e.g., *Siri Voice 1*, *Samantha (Enhanced)*). In System Settings > Accessibility > Spoken Content, download the "Enhanced" or "Premium" voice packs for hyper-realistic fidelity.
3. **Google Chrome**:
   - Use local system voices (e.g., Microsoft desktop voices on Windows, or system voices on macOS/Linux). Avoid voices marked with the cloud warning badge if you want pitch modulation.

---

## 📝 Inline Markup Support

You can add dynamic inline markup directly within your text:
- `*word*`: Applies immediate emphasis (higher pitch + slowed rate for that specific word).
- `[pause 500]`: Inserts an exact pause of 500 milliseconds (supports 50 to 5000 ms).
- `[pitch +0.3]` or `[pitch -0.2]`: Shifts pitch for subsequent sentences.
- `[rate +0.2]` or `[rate -0.2]`: Adjusts rate for subsequent sentences.
- `[voice Name]`: Switches sp## 🎙️ Voice Match (Browser-Only, Zero GPU / Zero Backend)

HumanVoice Studio runs **100% inside your browser** using vanilla Web Audio API and Web Speech API. There is **no GPU, no Python, no AI model, and no cloud upload** required.

> **Honest Capability Note:**
> *"Browser voices can't copy an exact voice. They match the clip's pitch, pace, pauses, expression, gender and language."*

---

### 🧬 How Browser Voice Matching Works (`voicematch.js`)

When you upload or record a reference speech clip (3–30 seconds), the browser analyses the raw audio samples using custom Digital Signal Processing (DSP) algorithms implemented directly in pure JavaScript:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        HumanVoice Studio (Browser)                     │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
            ┌────────────────────────┴─────────────────────────┐
            ▼                                                   ▼
┌───────────────────────────────────┐               ┌────────────────────┐
│      Reference Voice Match        │               │   Prosody Engine   │
│         (voicematch.js)           │               │    (prosody.js)    │
└─────────────────┬─────────────────┘               └─────────┬──────────┘
                  │                                           │
  ├─► Web Audio decode & 16 kHz Mono Resample                 ├─► Language Script Tagging
  ├─► YIN F0 Pitch Tracker (60–500 Hz, confidence > 0.8)      ├─► Dynamic Voice Switching
  ├─► 5-Frame Median Filter (octave jump removal)             ├─► Hindi Danda (। ॥) Splits
  ├─► Inline Cooley-Tukey Radix-2 FFT (Spectral Flatness)     ├─► Live Word-Boundary Speed
  ├─► 300–3000 Hz BiquadFilter Syllable Nuclei Detection      └─► SpeechSynthesis Queue
  ├─► Silence Runs (≥150ms) Pause & Rhythm Profiling
  └─► Auto-Tune Mapping & IndexedDB A/B Comparison
```

| Biometric Signal Extracted | Analysis Method | Studio Control Auto-Tuned |
| :--- | :--- | :--- |
| **`f0_median_hz`** (Base Pitch) | YIN algorithm with parabolic interpolation | Maps to **Pitch Slider** calibrated against voice type (female 210 Hz, male 120 Hz). |
| **`f0_std_semitones`** (Expressiveness) | Std deviation of $12 \times \log_2(f_0 / \text{median})$ | Auto-sets **Pitch Jitter** (5–45%) and **Humanize Intensity** (40–100%). |
| **`syllables_per_sec`** (Pacing) | Bandpass (300–3000 Hz) energy envelope peaks | Calibrated against voice speaking rate (`voice_sps`) to set **Speed / Rate** (0.6x–1.8x). |
| **`rate_variability`** (Rhythm CV) | Syllable count variation across 2s windows | Auto-sets **Speed Jitter** (5–30%). |
| **`pause_p90_ms`** (Inter-Phrase Pauses) | Silence runs $\ge 150$ ms between voiced segments | Auto-sets **Sentence Pause Length** (150–1200 ms). |
| **`loudness_std_db`** (Stress Dynamics) | Std deviation of voiced-frame dB | Auto-sets **Emphasis Strength** (15–80%). |
| **`quality_score`** & **`warnings`** | Spectral flatness (FFT) + clipping + SNR | Detects background music or noise and displays health score (0–100). |

- Auto-tuned controls display a green **`AUTO`** badge.
- Adjusting any slider marks that control as grey **`MANUAL`**.
- Clicking **"↺ Re-match"** restores all sliders to the clip's auto-matched parameters.
- Automatically saves a preset named **"Matched: <Clip Name>"** in Custom Presets.
- **A/B Comparison**: `"▶ Original Clip"` plays your uploaded audio directly from IndexedDB; `"▶ Browser Match"` speaks the editor text with the matched voice and parameters.

---

### 🌐 Intelligent Voice Selection & Language-Aware Speaking

1. **Smart Voice Scoring**:
   - Matches language (exact: +50, prefix: +35).
   - Matches gender using name keywords (+30). Female: *Swara, Neerja, Kalpana, Aria, Jenny, Zira, Samantha, etc.* Male: *Madhur, Prabhat, Hemant, Ravi, Guy, David, Mark, etc.*
   - Rewards high-quality voices (*Natural, Online, Neural, Enhanced, Premium*: +20).
   - Rewards local voices (+10) and avoids pitch-locked cloud voices (-15).
2. **Multi-Language & Mixed Speech**:
   - Detects script per sentence/phrase: Devanagari Unicode $\to$ Hindi (`hi-IN`), Latin $\to$ English (`en-IN`/`en-US`), Arabic, Cyrillic, CJK.
   - Automatically switches voices mid-paragraph when switching between Hindi and English!
   - Sentence segmentation properly handles Hindi danda `।` and double danda `॥` without false splits on decimals (`3.5`) or abbreviations (`Dr.`, `Mr.`).

---

### ⚡ True Dynamic Speed Control

1. **One Master Speed Control**:
   - Rate slider (`#rateSlider`) from **0.5× to 2.0×** in fine steps of 0.05.
   - Quick preset pills: `0.75x`, `1.0x`, `1.25x`, `1.5x`, `2.0x`.
2. **Instant Live Change While Speaking**:
   - When speed is adjusted during playback, speech restarts **from the current word** (tracked via `onboundary`) without jumping back to the sentence start or stuttering (debounced at 150 ms).
   - Inter-sentence pause durations scale inversely with speed.
3. **Protected Keyboard Shortcuts**:
   - `<kbd>[</kbd>` : Slower (-0.05x)
   - `<kbd>]</kbd>` : Faster (+0.05x)
   - `<kbd>\</kbd>` : Reset to 1.0x
   - **Editor Protection**: Shortcuts do not fire while typing inside textareas or inputs, allowing you to freely type tags like `[pause 500]` or `[rate +0.2]`.

---

### 🧪 Unit Test Suite (`test/voicematch.test.html`)

A standalone DSP unit test suite is included at [`test/voicematch.test.html`](test/voicematch.test.html). It synthesizes 150 Hz (male) and 220 Hz (female) audio signals with 4 Hz syllable modulation bursts and 300 ms silence gaps, and asserts:
- F0 Pitch accuracy within $\pm 3\%$
- Syllable rhythm pace within $\pm 15\%$
- Pause detection and voice type classification
- Prints **PASS / FAIL** for all assertions.


