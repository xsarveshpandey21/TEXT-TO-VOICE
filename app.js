/**
 * HumanVoice Studio - Main Application Controller
 * Coordinates playback queue, Web Speech API, prosody engine,
 * VoiceMatcher (in-browser acoustic DSP), presets, keyboard shortcuts,
 * dynamic speed control, and UI interactions.
 */

import { VoiceManager } from './voices.js';
import { ProsodyEngine } from './prosody.js';
import { BUILT_IN_PRESETS, PresetManager } from './presets.js';
import { Storage } from './storage.js';
import { UIController } from './ui.js';
import { VoiceMatcher } from './voicematch.js';
import { getVoiceGender, setVoiceGenderOverride, getVoiceGenderOverride } from './voicegender.js';

/**
 * Heuristic syllable counter for English (vowel groups, silent e, rhythm)
 */
export function countEnglishSyllables(text) {
  if (!text) return 0;
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  let total = 0;
  for (const word of words) {
    if (word.length <= 3) { total += 1; continue; }
    if (word === 'rhythm') { total += 2; continue; }
    let w = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
    w = w.replace(/^y/, '');
    const matches = w.match(/[aeiouy]{1,2}/g);
    total += matches ? Math.max(1, matches.length) : 1;
  }
  return total;
}

/**
 * Precise syllable counter for Hindi (Devanagari independent vowels, vowel matras, inherent vowels)
 */
export function countHindiSyllables(text) {
  if (!text) return 0;
  const independent = text.match(/[\u0904-\u0914\u0960-\u0961]/g) || [];
  const matras = text.match(/[\u093E-\u094C\u0962-\u0963]/g) || [];
  const inherent = text.match(/[\u0915-\u0939](?![\u093E-\u094D\u0962-\u0963])/g) || [];
  return independent.length + matras.length + inherent.length;
}

// IndexedDB storage for reference audio clips (A/B playback)
const ClipStore = {
  dbPromise: null,
  getDB() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('HumanVoiceStudioClips', 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('clips')) {
            db.createObjectStore('clips', { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  },
  async saveClip(id, blob, name) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('clips', 'readwrite');
        const store = tx.objectStore('clips');
        store.put({ id, blob, name, date: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('ClipStore save error:', e);
    }
  },
  async getClip(id) {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('clips', 'readonly');
        const store = tx.objectStore('clips');
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
  }
};

class HumanVoiceApp {
  constructor() {
    this.voiceManager = new VoiceManager();
    this.prosodyEngine = new ProsodyEngine(this.voiceManager);
    this.ui = new UIController();
    this.voiceMatcher = new VoiceMatcher();

    // Load persisted data
    const savedCustomPresets = Storage.loadCustomPresets();
    this.presetManager = new PresetManager(savedCustomPresets);
    this.savedSettings = Storage.loadSettings() || {};

    // Voice Matching State
    this.uploadedAudioBlob = null;
    this.currentVoiceProfile = null;
    this.currentVoiceLabel = 'My Reference Voice';
    this.manualClipGenderOverride = 'auto'; // 'auto' | 'male' | 'female'
    this.autoMatchedParams = null;
    this.storedClipId = this.savedSettings.storedClipId || null;
    this.activeOriginalAudio = null;
    this.isMicRecording = false;
    this.micMediaRecorder = null;
    this.micChunks = [];

    // Playback State
    this.playbackState = 'IDLE'; // 'IDLE' | 'SPEAKING' | 'PAUSED' | 'STOPPED'
    this.currentChunks = [];
    this.currentChunkIndex = 0;
    this.activeUtterance = null;
    this.pauseTimeoutId = null;
    this.chromeWatchdogInterval = null;
    this.lastWordCharIndex = 0;
    this.speedChangeDebounceTimer = null;

    // Active Settings
    this.activePresetId = this.savedSettings.activePresetId || 'neutral';
    this.selectedVoice = null;
    this.controls = {
      pitch: this.savedSettings.pitch ?? 1.0,
      rate: this.savedSettings.rate ?? 1.0,
      volume: this.savedSettings.volume ?? 1.0,
      pauseLength: this.savedSettings.pauseLength ?? 300,
      variationPitch: this.savedSettings.variationPitch ?? 12,
      variationRate: this.savedSettings.variationRate ?? 10,
      emphasisStrength: this.savedSettings.emphasisStrength ?? 0.4,
      humanizeEnabled: this.savedSettings.humanizeEnabled ?? true,
      humanizeIntensity: this.savedSettings.humanizeIntensity ?? 0.8,
      showAllLanguages: this.savedSettings.showAllLanguages ?? false,
      speakInLang: this.savedSettings.speakInLang || 'auto'
    };

    // DOM References
    this.elements = {};
  }

  async init() {
    // 1. Initialize complete UI first (Fix for Bug #3: don't return before UI setup)
    this._cacheDOMElements();
    this._initTheme();
    this.ui.initVisualizers();
    this._initSliders();
    this._initPresetsUI();
    this._initSampleTexts();
    this._initMarkupQuickBar();
    this._initRecordingUI();
    this._initModals();
    this._initKeyboardShortcuts();
    this._initTextStats();
    this._initVoiceMatchUI();
    this._initSpeedControls();

    // 2. Check SpeechSynthesis browser support
    if (!('speechSynthesis' in window)) {
      this._setStatus('⚠️ Web Speech API is not supported in this browser. Please use Chrome, Edge, or Safari.', 'error');
      return;
    }

    this._setStatus('Discovering browser voices...', 'info');

    // 3. Discover voices
    await this.voiceManager.init();
    this._populateVoiceDropdown();

    // 4. Update planned prosody and ready status
    this._updatePlannedProsody();
    this._setStatus('Ready to speak.', 'ready');
  }

  _cacheDOMElements() {
    const ids = [
      'textInput', 'charCountBadge', 'wordCountBadge', 'durationBadge',
      'voiceSelect', 'voiceSearchInput', 'showAllLangToggle', 'previewVoiceBtn',
      'speakLanguageSelect', 'cloudVoiceWarning', 'humanizeMasterToggle',
      'humanizeIntensitySlider', 'humanizeIntensityValue', 'pitchSlider',
      'pitchValue', 'resetPitchBtn', 'rateSlider', 'rateValue', 'resetRateBtn',
      'volumeSlider', 'volumeValue', 'resetVolumeBtn', 'pauseSlider',
      'pauseValue', 'resetPauseBtn', 'pitchVarSlider', 'pitchVarValue',
      'resetPitchVarBtn', 'rateVarSlider', 'rateVarValue', 'resetRateVarBtn',
      'emphasisSlider', 'emphasisValue', 'resetEmphasisBtn', 'speakBtn',
      'pauseBtn', 'resumeBtn', 'stopBtn', 'prevSentenceBtn', 'nextSentenceBtn',
      'statusText', 'playbackCardsContainer', 'recordBtn', 'recordStatusBadge',
      'themeToggleBtn', 'savePresetModal', 'openSavePresetBtn', 'presetNameInput',
      'confirmSavePresetBtn', 'cancelSavePresetBtn', 'configModal', 'openConfigBtn',
      'closeConfigBtn', 'exportConfigBtn', 'importConfigInput', 'clearTextBtn',
      'pasteTextBtn', 'autoPausesBtn', 'presetsContainer',
      // Voice Match UI Elements
      'voiceDropzone', 'dropzoneText', 'voiceFileInput', 'micRecordBtn',
      'micRecordText', 'voiceNameInput', 'analyzeVoiceBtn', 'rematchClipBtn',
      'analysisProgress', 'analysisProgressFill', 'analysisProgressText',
      'profileFingerprintPanel', 'qualityScoreBadge', 'statF0', 'statSps',
      'statExpressiveness', 'matchedVoiceReason', 'abCompareContainer',
      'playOriginalRefBtn', 'playBrowserMatchBtn', 'profileWarningsList',
      // Fix 1 & Fix 2 & Fix 3 & Fix 4 UI Elements
      'clipGenderToggleGroup', 'genderToggleAuto', 'genderToggleMale', 'genderToggleFemale',
      'voiceTypePanel', 'voiceTypeLabel', 'voiceTypeUncertainNotice',
      'voiceCalibStatsBanner', 'voiceCalibStatsText',
      'genderMismatchWarning', 'genderMismatchText',
      'voiceGenderOverrideBtn', 'voiceGenderOverrideIcon', 'calibrateVoiceBtn',
      'calibrationProgress', 'calibrationProgressText',
      // AUTO Chips
      'chipSpeed', 'chipPitch', 'chipPause', 'chipIntensity', 'chipEmphasis',
      'chipPitchVar', 'chipRateVar'
    ];
    ids.forEach(id => {
      this.elements[id] = document.getElementById(id);
    });
  }

  _initTheme() {
    const savedTheme = Storage.loadTheme();
    const applyTheme = (theme) => {
      if (theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      } else {
        document.documentElement.setAttribute('data-theme', theme);
      }
    };

    applyTheme(savedTheme);

    if (this.elements.themeToggleBtn) {
      this.elements.themeToggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        Storage.saveTheme(next);
      });
    }

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (Storage.loadTheme() === 'system') {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      }
    });
  }

  _initSliders() {
    const bindSlider = (slider, valueEl, key, formatFn = (v) => v, onReset = null, chipId = null) => {
      if (!slider) return;
      slider.value = this.controls[key];
      if (valueEl) valueEl.textContent = formatFn(this.controls[key]);

      slider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.controls[key] = val;
        if (valueEl) valueEl.textContent = formatFn(val);
        if (chipId) this._markChipManual(chipId);
        this._onControlChanged();
      });

      if (onReset) {
        onReset.addEventListener('click', () => {
          slider.value = slider.getAttribute('data-default') || 1.0;
          slider.dispatchEvent(new Event('input'));
        });
      }
    };

    bindSlider(this.elements.pitchSlider, this.elements.pitchValue, 'pitch', v => v.toFixed(2), this.elements.resetPitchBtn, 'chipPitch');
    bindSlider(this.elements.rateSlider, this.elements.rateValue, 'rate', v => v.toFixed(2) + 'x', this.elements.resetRateBtn, 'chipSpeed');
    bindSlider(this.elements.volumeSlider, this.elements.volumeValue, 'volume', v => Math.round(v * 100) + '%', this.elements.resetVolumeBtn);
    bindSlider(this.elements.pauseSlider, this.elements.pauseValue, 'pauseLength', v => Math.round(v) + 'ms', this.elements.resetPauseBtn, 'chipPause');
    bindSlider(this.elements.pitchVarSlider, this.elements.pitchVarValue, 'variationPitch', v => Math.round(v) + '%', this.elements.resetPitchVarBtn, 'chipPitchVar');
    bindSlider(this.elements.rateVarSlider, this.elements.rateVarValue, 'variationRate', v => Math.round(v) + '%', this.elements.resetRateVarBtn, 'chipRateVar');
    bindSlider(this.elements.emphasisSlider, this.elements.emphasisValue, 'emphasisStrength', v => Math.round(v * 100) + '%', this.elements.resetEmphasisBtn, 'chipEmphasis');

    // Humanize master toggle & intensity
    if (this.elements.humanizeMasterToggle) {
      this.elements.humanizeMasterToggle.checked = this.controls.humanizeEnabled;
      this.elements.humanizeMasterToggle.addEventListener('change', (e) => {
        this.controls.humanizeEnabled = e.target.checked;
        this._onControlChanged();
      });
    }

    if (this.elements.humanizeIntensitySlider) {
      this.elements.humanizeIntensitySlider.value = this.controls.humanizeIntensity;
      if (this.elements.humanizeIntensityValue) {
        this.elements.humanizeIntensityValue.textContent = Math.round(this.controls.humanizeIntensity * 100) + '%';
      }
      this.elements.humanizeIntensitySlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.controls.humanizeIntensity = val;
        if (this.elements.humanizeIntensityValue) {
          this.elements.humanizeIntensityValue.textContent = Math.round(val * 100) + '%';
        }
        this._markChipManual('chipIntensity');
        this._onControlChanged();
      });
    }
  }

  _markChipManual(chipId) {
    const chip = document.getElementById(chipId);
    if (chip && chip.style.display !== 'none') {
      chip.className = 'badge-auto manual';
      chip.textContent = 'MANUAL';
    }
  }

  _populateVoiceDropdown() {
    const select = this.elements.voiceSelect;
    if (!select) return;

    select.innerHTML = '';
    const showAll = this.elements.showAllLangToggle ? this.elements.showAllLangToggle.checked : this.controls.showAllLanguages;
    const query = this.elements.voiceSearchInput ? this.elements.voiceSearchInput.value : '';

    const grouped = this.voiceManager.getGroupedVoices(!showAll, query);
    const groupKeys = Object.keys(grouped).sort();

    // Fix for Bug #4: Don't return early; render disabled option but attach all event listeners
    if (groupKeys.length === 0) {
      const opt = document.createElement('option');
      opt.disabled = true;
      opt.textContent = 'No matching voices found';
      select.appendChild(opt);
    } else {
      const defaultVoice = this.voiceManager.getBestDefaultVoice();
      const savedVoiceURI = this.savedSettings.selectedVoiceURI;
      let voiceToSelect = this.voiceManager.findVoice(savedVoiceURI) || defaultVoice;

      groupKeys.forEach(langGroup => {
        const optGroup = document.createElement('optgroup');
        optGroup.label = langGroup;

        grouped[langGroup].forEach(voice => {
          const opt = document.createElement('option');
          opt.value = voice.voiceURI || voice.name;

          const gender = getVoiceGender(voice);
          const gIcon = gender === 'female' ? '♀ ' : (gender === 'male' ? '♂ ' : '? ');
          const isDefault = voice.default ? ' (Default)' : '';
          const isLocal = voice.localService ? ' [Local]' : ' [Online]';
          opt.textContent = `${gIcon}${voice.name}${isDefault}${isLocal}`;

          if (voiceToSelect && (voice.voiceURI === voiceToSelect.voiceURI || voice.name === voiceToSelect.name)) {
            opt.selected = true;
          }

          optGroup.appendChild(opt);
        });

        select.appendChild(optGroup);
      });

      this.selectedVoice = voiceToSelect;
      this._updateVoiceGenderOverrideUI();
      this._checkCloudVoiceWarning();
    }

    // Attach event listeners safely
    select.onchange = () => {
      const chosen = this.voiceManager.findVoice(select.value);
      if (chosen) {
        this.selectedVoice = chosen;
        this._updateVoiceGenderOverrideUI();
        this._checkCloudVoiceWarning();
        this._onControlChanged();
      }
    };

    // Hook manual gender override toggle button (Fix 1)
    if (this.elements.voiceGenderOverrideBtn && !this._voiceGenderOverrideBound) {
      this._voiceGenderOverrideBound = true;
      this.elements.voiceGenderOverrideBtn.addEventListener('click', () => {
        if (!this.selectedVoice) return;
        const vURI = this.selectedVoice.voiceURI || this.selectedVoice.name;
        const currentOverride = getVoiceGenderOverride(vURI);

        // Cycle: auto (null) -> female -> male -> auto
        let nextOverride = 'female';
        if (currentOverride === 'female') {
          nextOverride = 'male';
        } else if (currentOverride === 'male') {
          nextOverride = null;
        }

        setVoiceGenderOverride(vURI, nextOverride);
        this._populateVoiceDropdown();
        this._updateVoiceGenderOverrideUI();

        // If a reference clip is loaded, re-match with updated gender
        if (this.currentVoiceProfile) {
          const text = this.elements.textInput ? this.elements.textInput.value : '';
          this._autoMatchVoiceAndControls(this.currentVoiceProfile, this.currentVoiceLabel, text);
        }
      });
    }

    if (this.elements.showAllLangToggle && !this._showAllLangBound) {
      this._showAllLangBound = true;
      this.elements.showAllLangToggle.addEventListener('change', (e) => {
        this.controls.showAllLanguages = e.target.checked;
        this._populateVoiceDropdown();
      });
    }

    if (this.elements.voiceSearchInput && !this._voiceSearchBound) {
      this._voiceSearchBound = true;
      this.elements.voiceSearchInput.addEventListener('input', () => {
        this._populateVoiceDropdown();
      });
    }

    if (this.elements.speakLanguageSelect && !this._speakLangBound) {
      this._speakLangBound = true;
      this.elements.speakLanguageSelect.value = this.controls.speakInLang || 'auto';
      this.elements.speakLanguageSelect.addEventListener('change', (e) => {
        this.controls.speakInLang = e.target.value;
        this._onControlChanged();
      });
    }

    if (this.elements.previewVoiceBtn && !this._previewVoiceBound) {
      this._previewVoiceBound = true;
      this.elements.previewVoiceBtn.addEventListener('click', () => {
        if (this.selectedVoice) {
          this.voiceManager.previewVoice(this.selectedVoice, this.controls.pitch, this.controls.rate);
        }
      });
    }
  }

  _updateVoiceGenderOverrideUI() {
    if (!this.elements.voiceGenderOverrideBtn || !this.selectedVoice) return;
    const vURI = this.selectedVoice.voiceURI || this.selectedVoice.name;
    const manualOverride = getVoiceGenderOverride(vURI);
    const autoGender = getVoiceGender(this.selectedVoice);

    const btn = this.elements.voiceGenderOverrideBtn;
    const icon = this.elements.voiceGenderOverrideIcon;

    btn.classList.remove('male', 'female');

    if (manualOverride === 'male') {
      btn.classList.add('male');
      if (icon) icon.textContent = '♂ (manual)';
      btn.title = `Manual override: ♂ Male for "${this.selectedVoice.name}" (click to toggle)`;
    } else if (manualOverride === 'female') {
      btn.classList.add('female');
      if (icon) icon.textContent = '♀ (manual)';
      btn.title = `Manual override: ♀ Female for "${this.selectedVoice.name}" (click to toggle)`;
    } else {
      if (icon) {
        icon.textContent = autoGender === 'male' ? '♂ (auto)' : (autoGender === 'female' ? '♀ (auto)' : '? (auto)');
      }
      btn.title = `Auto-detected: ${autoGender} (click to override ♀/♂)`;
    }
  }

  _checkCloudVoiceWarning() {
    const isLimited = this.voiceManager.hasLimitedModulation(this.selectedVoice);
    if (this.elements.cloudVoiceWarning) {
      this.elements.cloudVoiceWarning.style.display = isLimited ? 'flex' : 'none';
      if (isLimited && !this.elements.cloudVoiceWarning.querySelector('.btn-switch-voice')) {
        const switchBtn = document.createElement('button');
        switchBtn.className = 'btn btn-secondary btn-sm btn-switch-voice';
        switchBtn.style.marginLeft = 'auto';
        switchBtn.textContent = 'Switch to Natural';
        switchBtn.onclick = () => {
          const natural = this.voiceManager.getVoices().find(v =>
            !this.voiceManager.hasLimitedModulation(v) &&
            (v.name.includes('Natural') || v.localService)
          );
          if (natural && this.elements.voiceSelect) {
            this.elements.voiceSelect.value = natural.voiceURI || natural.name;
            this.elements.voiceSelect.dispatchEvent(new Event('change'));
          }
        };
        this.elements.cloudVoiceWarning.appendChild(switchBtn);
      }
    }
  }

  _initPresetsUI() {
    const container = this.elements.presetsContainer;
    if (!container) return;

    container.innerHTML = '';
    const allPresets = this.presetManager.getAllPresets();

    allPresets.forEach(preset => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `preset-pill ${preset.id === this.activePresetId ? 'active' : ''} ${preset.isCustom ? 'custom' : ''}`;
      btn.dataset.presetId = preset.id;
      btn.title = preset.description || preset.name;

      btn.innerHTML = `
        <span class="preset-icon">${preset.icon || '✨'}</span>
        <span class="preset-name">${preset.name}</span>
        ${preset.isCustom ? '<span class="preset-delete-btn" title="Delete preset">✕</span>' : ''}
      `;

      btn.addEventListener('click', (e) => {
        if (e.target.classList.contains('preset-delete-btn')) {
          e.stopPropagation();
          this._deleteCustomPreset(preset.id);
          return;
        }
        this._applyPreset(preset);
      });

      container.appendChild(btn);
    });
  }

  _applyPreset(preset) {
    this.activePresetId = preset.id;
    this.currentPresetProfile = preset.curveProfile || 'neutral';

    // Restore voiceURI from preset if available (Fix 7)
    if (preset.voiceURI) {
      let restoredVoice = this.voiceManager.findVoice(preset.voiceURI);
      if (!restoredVoice && preset.lang) {
        restoredVoice = this._findBestVoiceForLanguage(preset.lang, preset.voiceType || 'female');
      }
      if (restoredVoice) {
        this.selectedVoice = restoredVoice;
        if (this.elements.voiceSelect) {
          this.elements.voiceSelect.value = restoredVoice.voiceURI || restoredVoice.name;
        }
        this._updateVoiceGenderOverrideUI();
        this._checkCloudVoiceWarning();
      }
    }

    this.controls.pitch = preset.pitch;
    this.controls.rate = preset.rate;
    this.controls.volume = preset.volume;
    this.controls.pauseLength = preset.pauseLength;
    this.controls.variationPitch = preset.variationPitch;
    this.controls.variationRate = preset.variationRate;
    this.controls.emphasisStrength = preset.emphasisStrength;
    this.controls.humanizeEnabled = preset.humanizeEnabled;
    this.controls.humanizeIntensity = preset.humanizeIntensity;

    this._syncSlidersFromControls();

    if (this.elements.presetsContainer) {
      this.elements.presetsContainer.querySelectorAll('.preset-pill').forEach(el => {
        el.classList.toggle('active', el.dataset.presetId === preset.id);
      });
    }

    this._onControlChanged();
    this._setStatus(`Preset loaded: "${preset.name}"`, 'info');
  }

  _syncSlidersFromControls() {
    const sync = (slider, valueEl, val, fmt) => {
      if (slider) slider.value = val;
      if (valueEl) valueEl.textContent = fmt(val);
    };

    sync(this.elements.pitchSlider, this.elements.pitchValue, this.controls.pitch, v => v.toFixed(2));
    sync(this.elements.rateSlider, this.elements.rateValue, this.controls.rate, v => v.toFixed(2) + 'x');
    sync(this.elements.volumeSlider, this.elements.volumeValue, this.controls.volume, v => Math.round(v * 100) + '%');
    sync(this.elements.pauseSlider, this.elements.pauseValue, this.controls.pauseLength, v => Math.round(v) + 'ms');
    sync(this.elements.pitchVarSlider, this.elements.pitchVarValue, this.controls.variationPitch, v => Math.round(v) + '%');
    sync(this.elements.rateVarSlider, this.elements.rateVarValue, this.controls.variationRate, v => Math.round(v) + '%');
    sync(this.elements.emphasisSlider, this.elements.emphasisValue, this.controls.emphasisStrength, v => Math.round(v * 100) + '%');

    if (this.elements.humanizeMasterToggle) {
      this.elements.humanizeMasterToggle.checked = this.controls.humanizeEnabled;
    }
    if (this.elements.humanizeIntensitySlider) {
      this.elements.humanizeIntensitySlider.value = this.controls.humanizeIntensity;
      if (this.elements.humanizeIntensityValue) {
        this.elements.humanizeIntensityValue.textContent = Math.round(this.controls.humanizeIntensity * 100) + '%';
      }
    }
    this._updateSpeedPillsUI(this.controls.rate);
  }

  _deleteCustomPreset(id) {
    if (confirm('Delete this custom preset?')) {
      const updated = this.presetManager.deleteCustomPreset(id);
      Storage.saveCustomPresets(updated);
      this._initPresetsUI();
      if (this.activePresetId === id) {
        this._applyPreset(BUILT_IN_PRESETS[0]);
      }
    }
  }

  _initSampleTexts() {
    const samples = {
      story: `The old lighthouse stood silent against the crashing waves. For forty years, Arthur had kept the flame alive... but tonight was different. Did you hear that sudden whisper in the mist? Look! The lantern had flickered out!`,
      dialogue: `[voice Natural] Hello there! Did you get my message about the launch?\n[pitch +0.2] *Absolutely!* Everything is set for tomorrow.\n[voice Guy] [pitch -0.1] Wait... are we truly ready for the storm outside?`,
      inflection: `Can you really hear the pitch rising at the end of this question? Wow! That was an incredible explosion of sound! Sometimes... we just need a slow, thoughtful breath. And then we proceed with steady confidence.`,
      markup: `Welcome to *HumanVoice Studio*! [pause 600] We can insert custom pauses, [pitch +0.3] elevate our pitch for excitement, [rate -0.2] slow down for dramatic emphasis, and return seamlessly to normal.`
    };

    document.querySelectorAll('[data-sample]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sample;
        if (samples[key] && this.elements.textInput) {
          this.elements.textInput.value = samples[key];
          this._updateTextStats();
          this._updatePlannedProsody();
        }
      });
    });

    if (this.elements.clearTextBtn) {
      this.elements.clearTextBtn.addEventListener('click', () => {
        if (this.elements.textInput) {
          this.elements.textInput.value = '';
          this._updateTextStats();
          this._updatePlannedProsody();
        }
      });
    }

    if (this.elements.pasteTextBtn) {
      this.elements.pasteTextBtn.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text && this.elements.textInput) {
            this.elements.textInput.value = text;
            this._updateTextStats();
            this._updatePlannedProsody();
          }
        } catch (e) {
          alert('Clipboard paste permission denied or not supported.');
        }
      });
    }

    if (this.elements.autoPausesBtn) {
      this.elements.autoPausesBtn.addEventListener('click', () => {
        if (!this.elements.textInput) return;
        let text = this.elements.textInput.value;
        text = text.replace(/([;:])\s+/g, '$1 [pause 400] ');
        this.elements.textInput.value = text;
        this._updatePlannedProsody();
      });
    }
  }

  _initMarkupQuickBar() {
    const insertMarkup = (before, after = '') => {
      const textarea = this.elements.textInput;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      const selected = text.substring(start, end);

      const replacement = before + (selected || 'word') + after;
      textarea.value = text.substring(0, start) + replacement + text.substring(end);
      textarea.focus();
      textarea.setSelectionRange(start + before.length, start + replacement.length - after.length);

      this._updateTextStats();
      this._updatePlannedProsody();
    };

    document.querySelectorAll('[data-markup]').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.markup;
        switch (type) {
          case 'emphasis':
            insertMarkup('*', '*');
            break;
          case 'pause':
            insertMarkup('[pause 500]');
            break;
          case 'pitch_up':
            insertMarkup('[pitch +0.2] ');
            break;
          case 'pitch_down':
            insertMarkup('[pitch -0.2] ');
            break;
          case 'rate_fast':
            insertMarkup('[rate +0.2] ');
            break;
          case 'rate_slow':
            insertMarkup('[rate -0.2] ');
            break;
        }
      });
    });
  }

  _initRecordingUI() {
    if (!this.elements.recordBtn) return;

    this.elements.recordBtn.addEventListener('click', async () => {
      if (this.ui.isRecording) {
        this.ui.stopRecording();
      } else {
        const ok = await this.ui.startRecording((recording) => {
          if (this.elements.recordBtn) {
            this.elements.recordBtn.classList.toggle('recording', recording);
            this.elements.recordBtn.textContent = recording ? '⏹️ Stop Recording' : '🔴 Record Tab Audio';
          }
          if (this.elements.recordStatusBadge) {
            this.elements.recordStatusBadge.style.display = recording ? 'inline-flex' : 'none';
          }
        });

        if (ok) {
          this._setStatus('Recording tab audio. Click "Speak" to begin playback!', 'info');
        }
      }
    });
  }

  _initModals() {
    // Save Custom Preset Modal
    if (this.elements.openSavePresetBtn && this.elements.savePresetModal) {
      this.elements.openSavePresetBtn.addEventListener('click', () => {
        this.elements.savePresetModal.style.display = 'flex';
        if (this.elements.presetNameInput) {
          this.elements.presetNameInput.value = '';
          this.elements.presetNameInput.focus();
        }
      });
    }

    if (this.elements.cancelSavePresetBtn) {
      this.elements.cancelSavePresetBtn.addEventListener('click', () => {
        this.elements.savePresetModal.style.display = 'none';
      });
    }

    if (this.elements.confirmSavePresetBtn) {
      this.elements.confirmSavePresetBtn.addEventListener('click', () => {
        const name = (this.elements.presetNameInput?.value || '').trim();
        if (!name) {
          alert('Please enter a preset name.');
          return;
        }

        const newPreset = {
          id: 'custom_' + Date.now(),
          name: name,
          icon: '⭐',
          description: `Custom preset: Pitch ${this.controls.pitch.toFixed(2)}, Rate ${this.controls.rate.toFixed(2)}x`,
          isCustom: true,
          pitch: this.controls.pitch,
          rate: this.controls.rate,
          volume: this.controls.volume,
          pauseLength: this.controls.pauseLength,
          variationPitch: this.controls.variationPitch,
          variationRate: this.controls.variationRate,
          emphasisStrength: this.controls.emphasisStrength,
          humanizeEnabled: this.controls.humanizeEnabled,
          humanizeIntensity: this.controls.humanizeIntensity,
          curveProfile: this.currentPresetProfile || 'neutral'
        };

        const updated = this.presetManager.saveCustomPreset(newPreset);
        Storage.saveCustomPresets(updated);
        this.activePresetId = newPreset.id;
        this._initPresetsUI();
        this.elements.savePresetModal.style.display = 'none';
        this._setStatus(`Custom preset "${name}" saved!`, 'ready');
      });
    }

    // Export/Import Modal
    if (this.elements.openConfigBtn && this.elements.configModal) {
      this.elements.openConfigBtn.addEventListener('click', () => {
        this.elements.configModal.style.display = 'flex';
      });
    }

    if (this.elements.closeConfigBtn) {
      this.elements.closeConfigBtn.addEventListener('click', () => {
        this.elements.configModal.style.display = 'none';
      });
    }

    if (this.elements.exportConfigBtn) {
      this.elements.exportConfigBtn.addEventListener('click', () => {
        const json = Storage.exportConfigJSON(this.controls, this.presetManager.customPresets);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `humanvoice_config_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    if (this.elements.importConfigInput) {
      this.elements.importConfigInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const data = Storage.importConfigJSON(event.target.result);
            if (data.settings) {
              Object.assign(this.controls, data.settings);
              this._syncSlidersFromControls();
            }
            if (data.customPresets && data.customPresets.length > 0) {
              data.customPresets.forEach(p => this.presetManager.saveCustomPreset(p));
              Storage.saveCustomPresets(this.presetManager.customPresets);
              this._initPresetsUI();
            }
            this.elements.configModal.style.display = 'none';
            this._onControlChanged();
            alert('Configuration imported successfully!');
          } catch (err) {
            alert('Failed to import config: ' + err.message);
          }
        };
        reader.readAsText(file);
      });
    }
  }

  _initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Ctrl+Enter or Cmd+Enter: Speak
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.handleSpeak();
        return;
      }

      // Escape: Stop
      if (e.key === 'Escape') {
        if (this.playbackState === 'SPEAKING' || this.playbackState === 'PAUSED') {
          e.preventDefault();
          this.handleStop();
        }
        return;
      }

      // Guard for typing in text inputs (Fix for Bug #1: don't intercept [, ], \, space while typing in textarea)
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      const isTyping = activeTag === 'TEXTAREA' || activeTag === 'INPUT' || activeTag === 'SELECT';

      // Space: Play/Pause (only when NOT focused inside text input or textarea)
      if (e.key === ' ' && !isTyping) {
        e.preventDefault();
        if (this.playbackState === 'SPEAKING') {
          this.handlePause();
        } else if (this.playbackState === 'PAUSED') {
          this.handleResume();
        } else {
          this.handleSpeak();
        }
        return;
      }

      // Speed control shortcuts: Ignore if typing or if modifiers are pressed
      if (isTyping || e.ctrlKey || e.altKey || e.metaKey) {
        return;
      }

      // [ : Slower speed (-0.05x)
      if (e.key === '[') {
        e.preventDefault();
        this._adjustSpeed(-0.05);
        return;
      }

      // ] : Faster speed (+0.05x)
      if (e.key === ']') {
        e.preventDefault();
        this._adjustSpeed(0.05);
        return;
      }

      // \ : Reset speed to 1.0x
      if (e.key === '\\') {
        e.preventDefault();
        this._setSpeed(1.0);
        return;
      }
    });

    // Playback control buttons
    if (this.elements.speakBtn) this.elements.speakBtn.addEventListener('click', () => this.handleSpeak());
    if (this.elements.pauseBtn) this.elements.pauseBtn.addEventListener('click', () => this.handlePause());
    if (this.elements.resumeBtn) this.elements.resumeBtn.addEventListener('click', () => this.handleResume());
    if (this.elements.stopBtn) this.elements.stopBtn.addEventListener('click', () => this.handleStop());
    if (this.elements.prevSentenceBtn) this.elements.prevSentenceBtn.addEventListener('click', () => this.skipSentence(-1));
    if (this.elements.nextSentenceBtn) this.elements.nextSentenceBtn.addEventListener('click', () => this.skipSentence(1));
  }

  _initTextStats() {
    if (!this.elements.textInput) return;
    this.elements.textInput.addEventListener('input', () => {
      this._updateTextStats();
      this._updatePlannedProsody();
    });
  }

  _updateTextStats() {
    const text = this.elements.textInput ? this.elements.textInput.value : '';
    const charCount = text.length;
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

    if (this.elements.charCountBadge) this.elements.charCountBadge.textContent = `${charCount} chars`;
    if (this.elements.wordCountBadge) this.elements.wordCountBadge.textContent = `${wordCount} words`;

    const estSec = this.prosodyEngine.estimateDuration(this.currentChunks);
    if (this.elements.durationBadge) {
      const mins = Math.floor(estSec / 60);
      const secs = estSec % 60;
      this.elements.durationBadge.textContent = `~${mins > 0 ? `${mins}m ` : ''}${secs}s`;
    }
  }

  _onControlChanged() {
    this._saveCurrentState();
    this._updatePlannedProsody();
  }

  _saveCurrentState() {
    const toSave = {
      ...this.controls,
      activePresetId: this.activePresetId,
      selectedVoiceURI: this.selectedVoice ? (this.selectedVoice.voiceURI || this.selectedVoice.name) : null,
      storedClipId: this.storedClipId
    };
    Storage.saveSettings(toSave);
  }

  _updatePlannedProsody() {
    const text = this.elements.textInput ? this.elements.textInput.value : '';
    this.currentChunks = this.prosodyEngine.process(text, {
      defaultVoice: this.selectedVoice,
      speakInLang: this.controls.speakInLang,
      basePitch: this.controls.pitch,
      baseRate: this.controls.rate,
      baseVolume: this.controls.volume,
      pauseLength: this.controls.pauseLength,
      variationPitch: this.controls.variationPitch,
      variationRate: this.controls.variationRate,
      emphasisStrength: this.controls.emphasisStrength,
      humanizeEnabled: this.controls.humanizeEnabled,
      humanizeIntensity: this.controls.humanizeIntensity,
      curveProfile: this.currentPresetProfile || 'neutral'
    });

    this.ui.renderProsodyGraph(this.currentChunks, this.currentChunkIndex);
    this._updateTextStats();
  }

  // --- PLAYBACK ENGINE ---
  async handleSpeak() {
    const text = this.elements.textInput ? this.elements.textInput.value.trim() : '';
    if (!text) {
      this._setStatus('Please enter some text to speak.', 'error');
      return;
    }

    // Fix for Bug #8: Stop any preview or reference clip audio before speaking
    if (this.activeOriginalAudio) {
      this.activeOriginalAudio.pause();
      this.activeOriginalAudio.currentTime = 0;
      this.activeOriginalAudio = null;
      if (this.elements.playOriginalRefBtn) this.elements.playOriginalRefBtn.classList.remove('playing');
    }

    // Cancel any active Web Speech utterance
    window.speechSynthesis.cancel();
    clearTimeout(this.pauseTimeoutId);
    this._clearWatchdog();

    // Recompute planned chunks
    this._updatePlannedProsody();
    if (this.currentChunks.length === 0) return;

    this.currentChunkIndex = 0;
    this.playbackState = 'SPEAKING';
    this._updatePlaybackControlsUI();

    // Render interactive cards
    this.ui.renderPlaybackCards(this.elements.playbackCardsContainer, this.currentChunks, 0);

    // Speak first chunk
    this._playChunk(this.currentChunkIndex);
  }

  handlePause() {
    if (this.playbackState !== 'SPEAKING') return;

    this.playbackState = 'PAUSED';
    clearTimeout(this.pauseTimeoutId);
    this._clearWatchdog();

    window.speechSynthesis.cancel();
    this.ui.isSpeaking = false;
    this._updatePlaybackControlsUI();
    this._setStatus(`Paused at sentence ${this._getCurrentSentenceNum()}/${this._getTotalSentences()}`, 'info');
  }

  handleResume() {
    if (this.playbackState !== 'PAUSED') return;

    this.playbackState = 'SPEAKING';
    this._updatePlaybackControlsUI();
    this._playChunk(this.currentChunkIndex);
  }

  handleStop() {
    this.playbackState = 'STOPPED';
    clearTimeout(this.pauseTimeoutId);
    this._clearWatchdog();

    window.speechSynthesis.cancel();
    this.ui.isSpeaking = false;
    this.currentChunkIndex = 0;
    this.lastWordCharIndex = 0;
    this.ui.updateActiveChunk(-1, this.currentChunks);
    this._updatePlaybackControlsUI();
    this._setStatus('Playback stopped.', 'ready');
  }

  skipSentence(direction) {
    if (this.currentChunks.length === 0) return;

    const currentSentenceIdx = this.currentChunks[this.currentChunkIndex]?.sentenceIndex || 0;
    const targetSentenceIdx = Math.max(0, currentSentenceIdx + direction);

    const newChunkIdx = this.currentChunks.findIndex(c => c.sentenceIndex === targetSentenceIdx);
    if (newChunkIdx !== -1) {
      this.currentChunkIndex = newChunkIdx;
      this.lastWordCharIndex = 0;
      if (this.playbackState === 'SPEAKING') {
        window.speechSynthesis.cancel();
        clearTimeout(this.pauseTimeoutId);
        this._playChunk(this.currentChunkIndex);
      } else {
        this.ui.updateActiveChunk(this.currentChunkIndex, this.currentChunks);
        this._setStatus(`Jumped to sentence ${this._getCurrentSentenceNum()}/${this._getTotalSentences()}`, 'info');
      }
    }
  }

  _playChunk(index) {
    if (this.playbackState !== 'SPEAKING') return;

    if (index >= this.currentChunks.length) {
      this.handleStop();
      this._setStatus('Finished speaking.', 'ready');
      return;
    }

    const chunk = this.currentChunks[index];
    this.ui.updateActiveChunk(index, this.currentChunks);

    const sentNum = this._getCurrentSentenceNum();
    const totalSent = this._getTotalSentences();
    this._setStatus(`Speaking sentence ${sentNum}/${totalSent}...`, 'speaking');

    // Handle pause-only chunks (divide pause by current speed)
    if (chunk.isPauseOnly || !chunk.cleanText) {
      this.ui.isSpeaking = false;
      const pauseDuration = Math.round((chunk.pauseAfterMs || 300) / this.controls.rate);
      this.pauseTimeoutId = setTimeout(() => {
        this.currentChunkIndex = index + 1;
        this._playChunk(this.currentChunkIndex);
      }, pauseDuration);
      return;
    }

    // Dynamic Language-Aware Voice Switching (Fix 7)
    let chunkVoice = chunk.voice || this.selectedVoice;
    let chunkPitch = chunk.pitch;
    let chunkRate = Math.max(0.5, Math.min(2.0, chunk.rate));

    if (chunk.lang) {
      const chunkLangCode = chunk.lang.split('-')[0].toLowerCase();
      const currentVoiceLangCode = (chunkVoice ? chunkVoice.lang : '').split(/[-_]/)[0].toLowerCase();

      if (chunkLangCode !== currentVoiceLangCode) {
        const matchingVoice = this._findBestVoiceForLanguage(chunk.lang);
        if (matchingVoice) {
          chunkVoice = matchingVoice;
          // Re-tune pitch and rate for that voice using its calibration/defaults (Fix 7)
          const retuned = this._retuneChunkForVoice(chunk, matchingVoice);
          chunkPitch = retuned.pitch;
          chunkRate = retuned.rate;
        } else if (chunkLangCode === 'hi') {
          this._setStatus('⚠️ No Hindi voice installed — open in Microsoft Edge or add Hindi voice in Windows Settings.', 'info');
        }
      }
    }

    // Create Utterance
    const utterance = new SpeechSynthesisUtterance(chunk.cleanText);
    utterance.voice = chunkVoice;
    utterance.pitch = chunkPitch;
    utterance.rate = chunkRate;
    utterance.volume = chunk.volume;

    this.activeUtterance = utterance;
    this.lastWordCharIndex = 0;

    // Events
    utterance.onstart = () => {
      if (this.playbackState !== 'SPEAKING') return;
      this.ui.isSpeaking = true;
      this._startWatchdog();
    };

    utterance.onboundary = (e) => {
      this.ui.pulseBoundary();
      // Track character index for seamless mid-sentence speed adjustment
      if (typeof e.charIndex === 'number') {
        this.lastWordCharIndex = e.charIndex;
      }
    };

    utterance.onend = () => {
      this._clearWatchdog();
      if (this.playbackState !== 'SPEAKING') return;

      this.ui.isSpeaking = false;
      const delay = Math.round((chunk.pauseAfterMs || 60) / this.controls.rate);
      this.pauseTimeoutId = setTimeout(() => {
        this.currentChunkIndex = index + 1;
        this._playChunk(this.currentChunkIndex);
      }, delay);
    };

    utterance.onerror = (e) => {
      this._clearWatchdog();
      if (e.error === 'interrupted' || e.error === 'canceled') {
        return;
      }
      console.warn('SpeechSynthesisUtterance event:', e.error);
      this.currentChunkIndex = index + 1;
      this._playChunk(this.currentChunkIndex);
    };

    window.speechSynthesis.speak(utterance);
  }

  /**
   * Seamless live rate adjustment while speaking:
   * Restarts current chunk from the last word boundary with updated rate.
   */
  _restartCurrentChunkAtNewRate() {
    if (this.playbackState !== 'SPEAKING') return;
    const chunk = this.currentChunks[this.currentChunkIndex];
    if (!chunk || chunk.isPauseOnly || !chunk.cleanText) return;

    const fullText = chunk.cleanText;
    const remainingText = fullText.slice(this.lastWordCharIndex).trim();
    if (!remainingText) return;

    this._clearWatchdog();
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(remainingText);
    utterance.voice = chunk.voice || this.selectedVoice;
    utterance.pitch = chunk.pitch;
    utterance.rate = Math.max(0.5, Math.min(2.0, this.controls.rate));
    utterance.volume = chunk.volume;

    this.activeUtterance = utterance;
    const baseOffset = this.lastWordCharIndex;

    utterance.onstart = () => {
      if (this.playbackState !== 'SPEAKING') return;
      this.ui.isSpeaking = true;
      this._startWatchdog();
    };

    utterance.onboundary = (e) => {
      this.ui.pulseBoundary();
      if (typeof e.charIndex === 'number') {
        this.lastWordCharIndex = baseOffset + e.charIndex;
      }
    };

    utterance.onend = () => {
      this._clearWatchdog();
      if (this.playbackState !== 'SPEAKING') return;
      this.ui.isSpeaking = false;
      const delay = Math.round((chunk.pauseAfterMs || 60) / this.controls.rate);
      this.pauseTimeoutId = setTimeout(() => {
        this.currentChunkIndex = this.currentChunkIndex + 1;
        this._playChunk(this.currentChunkIndex);
      }, delay);
    };

    utterance.onerror = (e) => {
      this._clearWatchdog();
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.currentChunkIndex = this.currentChunkIndex + 1;
      this._playChunk(this.currentChunkIndex);
    };

    window.speechSynthesis.speak(utterance);
  }

  _retuneChunkForVoice(chunk, targetVoice) {
    if (!targetVoice) return { pitch: chunk.pitch, rate: chunk.rate };
    const clipF0 = (this.currentVoiceProfile && this.currentVoiceProfile.f0_median_hz) || 160;
    const clipSps = (this.currentVoiceProfile && this.currentVoiceProfile.syllables_per_sec) || 4.2;

    const calib = this._getVoiceCalibration(targetVoice, chunk.lang || targetVoice.lang);
    const vGender = getVoiceGender(targetVoice);
    const defaultBase = vGender === 'male' ? 115 : (vGender === 'female' ? 205 : 160);
    const vBaseF0 = (calib && calib.baseF0) || defaultBase;
    const vK = (calib && calib.k) || 1.0;
    const vSps = (calib && calib.sps) || 4.2;

    const pitchMin = Math.pow(2, -5 / 12); // ~0.749
    const pitchMax = Math.pow(2, 5 / 12);  // ~1.335
    const rawPitch = Math.pow(clipF0 / vBaseF0, 1.0 / vK);
    const tunedPitch = Math.max(pitchMin, Math.min(pitchMax, rawPitch));
    const tunedRate = Math.max(0.6, Math.min(1.8, clipSps / vSps));

    return {
      pitch: Number(tunedPitch.toFixed(2)),
      rate: Number(tunedRate.toFixed(2))
    };
  }

  _findBestVoiceForLanguage(langCode, targetGenderOrRef = null) {
    const voices = this.voiceManager.getVoices();
    if (!voices || voices.length === 0) return null;

    const targetCode = langCode.split(/[-_]/)[0].toLowerCase();

    // Determine target gender from explicit override, clip profile, or voice (Fix 7)
    let targetGender = 'female';
    if (typeof targetGenderOrRef === 'string') {
      targetGender = targetGenderOrRef;
    } else if (this.manualClipGenderOverride && this.manualClipGenderOverride !== 'auto') {
      targetGender = this.manualClipGenderOverride;
    } else if (this.currentVoiceProfile && this.currentVoiceProfile.voice_type === 'male') {
      targetGender = 'male';
    } else if (targetGenderOrRef && typeof targetGenderOrRef === 'object') {
      targetGender = getVoiceGender(targetGenderOrRef);
    } else if (this.selectedVoice) {
      targetGender = getVoiceGender(this.selectedVoice);
    }

    const matches = voices.filter(v => v.lang.toLowerCase().startsWith(targetCode));
    if (matches.length === 0) return null;

    // Rank matching voices with exact gender weight (+40 match, -40 opposite)
    matches.sort((a, b) => {
      const aG = getVoiceGender(a);
      const bG = getVoiceGender(b);
      const aGenderScore = aG === targetGender ? 40 : (aG !== 'unknown' ? -40 : 0);
      const bGenderScore = bG === targetGender ? 40 : (bG !== 'unknown' ? -40 : 0);
      const aNat = /natural|online|neural|enhanced/i.test(a.name) ? 15 : 0;
      const bNat = /natural|online|neural|enhanced/i.test(b.name) ? 15 : 0;
      const aLocal = a.localService ? 5 : 0;
      const bLocal = b.localService ? 5 : 0;
      return (bGenderScore + bNat + bLocal) - (aGenderScore + aNat + aLocal);
    });

    return matches[0];
  }

  // Chrome 15-second cutoff watchdog keep-alive
  _startWatchdog() {
    this._clearWatchdog();
    let seconds = 0;
    this.chromeWatchdogInterval = setInterval(() => {
      seconds += 1;
      if (seconds >= 12 && window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
        seconds = 0;
      }
    }, 1000);
  }

  _clearWatchdog() {
    if (this.chromeWatchdogInterval) {
      clearInterval(this.chromeWatchdogInterval);
      this.chromeWatchdogInterval = null;
    }
  }

  _getCurrentSentenceNum() {
    if (!this.currentChunks[this.currentChunkIndex]) return 1;
    return (this.currentChunks[this.currentChunkIndex].sentenceIndex || 0) + 1;
  }

  _getTotalSentences() {
    if (this.currentChunks.length === 0) return 1;
    return (this.currentChunks[this.currentChunks.length - 1].sentenceIndex || 0) + 1;
  }

  _updatePlaybackControlsUI() {
    const isPlaying = this.playbackState === 'SPEAKING';
    const isPaused = this.playbackState === 'PAUSED';

    if (this.elements.speakBtn) this.elements.speakBtn.style.display = (isPlaying || isPaused) ? 'none' : 'inline-flex';
    if (this.elements.pauseBtn) this.elements.pauseBtn.style.display = isPlaying ? 'inline-flex' : 'none';
    if (this.elements.resumeBtn) this.elements.resumeBtn.style.display = isPaused ? 'inline-flex' : 'none';
    if (this.elements.stopBtn) this.elements.stopBtn.disabled = !(isPlaying || isPaused);
  }

  _setStatus(msg, type = 'ready') {
    if (!this.elements.statusText) return;
    this.elements.statusText.textContent = msg;
    this.elements.statusText.className = `status-text ${type}`;
  }

  // ===== BROWSER VOICE MATCH & SPEED CONTROL (Step 2, 3, 5) =====

  _initVoiceMatchUI() {
    const dropzone = this.elements.voiceDropzone;
    const fileInput = this.elements.voiceFileInput;
    const analyzeBtn = this.elements.analyzeVoiceBtn;
    const micBtn = this.elements.micRecordBtn;

    const checkReady = () => {
      if (analyzeBtn) analyzeBtn.disabled = !this.uploadedAudioBlob;
    };

    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          this._handleSelectedAudioFile(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          this._handleSelectedAudioFile(e.target.files[0]);
        }
      });
    }

    if (micBtn) {
      micBtn.addEventListener('click', async () => {
        if (this.isMicRecording) {
          this._stopMicRecording();
        } else {
          await this._startMicRecording();
        }
      });
    }

    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', async () => {
        await this._handleAnalyzeVoice();
      });
    }

    if (this.elements.rematchClipBtn) {
      this.elements.rematchClipBtn.addEventListener('click', () => {
        this._restoreAutoParams();
      });
    }

    // A/B Comparison Buttons
    if (this.elements.playOriginalRefBtn) {
      this.elements.playOriginalRefBtn.addEventListener('click', async () => {
        await this._playOriginalReferenceClip();
      });
    }

    if (this.elements.playBrowserMatchBtn) {
      this.elements.playBrowserMatchBtn.addEventListener('click', () => {
        this._playBrowserMatchSample();
      });
    }

    // 3-Way Clip Gender Toggle (Fix 2: Auto / Male / Female override)
    ['genderToggleAuto', 'genderToggleMale', 'genderToggleFemale'].forEach(id => {
      const btn = this.elements[id];
      if (btn) {
        btn.addEventListener('click', () => {
          this.manualClipGenderOverride = btn.dataset.gender || 'auto';
          if (this.currentVoiceProfile) {
            const text = this.elements.textInput ? this.elements.textInput.value : '';
            this._autoMatchVoiceAndControls(this.currentVoiceProfile, this.currentVoiceLabel, text);
          }
        });
      }
    });

    // Voice Pitch & Speed Calibration Button (Fix 4)
    if (this.elements.calibrateVoiceBtn) {
      this.elements.calibrateVoiceBtn.addEventListener('click', async () => {
        if (this.selectedVoice) {
          await this._handleCalibrateVoice(this.selectedVoice);
        }
      });
    }
  }

  _handleSelectedAudioFile(file) {
    this.uploadedAudioBlob = file;
    if (this.elements.dropzoneText) {
      this.elements.dropzoneText.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
    }
    if (this.elements.analyzeVoiceBtn) {
      this.elements.analyzeVoiceBtn.disabled = false;
    }
  }

  async _startMicRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micChunks = [];
      this.micMediaRecorder = new MediaRecorder(stream);
      this.micMediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.micChunks.push(e.data);
      };
      this.micMediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(this.micChunks, { type: 'audio/webm' });
        this.uploadedAudioBlob = blob;
        if (this.elements.dropzoneText) {
          this.elements.dropzoneText.textContent = `Recorded mic audio (${(blob.size / 1024).toFixed(0)} KB)`;
        }
        if (this.elements.analyzeVoiceBtn) {
          this.elements.analyzeVoiceBtn.disabled = false;
        }
      };

      this.micMediaRecorder.start();
      this.isMicRecording = true;
      if (this.elements.micRecordBtn) this.elements.micRecordBtn.classList.add('recording');
      if (this.elements.micRecordText) this.elements.micRecordText.textContent = '⏹️ Stop Mic';
      this._setStatus('Recording microphone audio (speak naturally for 5–15s)...', 'info');

      // Auto-stop at 15s max
      setTimeout(() => {
        if (this.isMicRecording) {
          this._stopMicRecording();
        }
      }, 15000);
    } catch (e) {
      alert('Could not access microphone: ' + e.message);
    }
  }

  _stopMicRecording() {
    if (this.micMediaRecorder && this.isMicRecording) {
      this.micMediaRecorder.stop();
      this.isMicRecording = false;
      if (this.elements.micRecordBtn) this.elements.micRecordBtn.classList.remove('recording');
      if (this.elements.micRecordText) this.elements.micRecordText.textContent = 'Record Mic (15s)';
      this._setStatus('Microphone recording finished. Click "Analyze & Auto-Match".', 'ready');
    }
  }

  async _handleAnalyzeVoice() {
    if (!this.uploadedAudioBlob) return;
    const voiceLabel = (this.elements.voiceNameInput ? this.elements.voiceNameInput.value : '').trim() || 'My Reference Voice';

    const progressBar = this.elements.analysisProgress;
    const progressFill = this.elements.analysisProgressFill;
    const progressText = this.elements.analysisProgressText;
    const analyzeBtn = this.elements.analyzeVoiceBtn;

    if (progressBar) progressBar.style.display = 'flex';
    if (analyzeBtn) analyzeBtn.disabled = true;

    this._setStatus('Analyzing audio clip & extracting acoustic fingerprint in browser…', 'info');

    try {
      const profile = await this.voiceMatcher.analyze(this.uploadedAudioBlob, (pct, msg) => {
        if (progressFill) progressFill.style.width = pct + '%';
        if (progressText) progressText.textContent = msg || `Analyzing… ${pct}%`;
      });

      this.currentVoiceProfile = profile;
      const clipId = 'clip_' + Date.now();
      this.storedClipId = clipId;
      await ClipStore.saveClip(clipId, this.uploadedAudioBlob, voiceLabel);

      // Perform Auto-Match (Step 3)
      const text = this.elements.textInput ? this.elements.textInput.value : '';
      const matchResult = await this._autoMatchVoiceAndControls(profile, voiceLabel, text);

      // Display profile fingerprint in UI
      this._displayProfileFingerprint(profile, matchResult.voice, matchResult.reason);

      this._saveCurrentState();
      this._setStatus(`Voice "${voiceLabel}" successfully analyzed & auto-matched!`, 'ready');
    } catch (e) {
      console.error(e);
      this._setStatus(`Voice analysis error: ${e.message}`, 'error');
      alert(`Voice analysis error: ${e.message}`);
    } finally {
      if (progressBar) progressBar.style.display = 'none';
      if (analyzeBtn) analyzeBtn.disabled = false;
    }
  }

  /**
   * Auto-Match algorithm (Fix 1, Fix 3, Fix 4, Fix 6):
   * Selects browser voice and tunes modulation controls using chosen voice base F0,
   * safe-zone gender classification, differential SPS timing, and unbiased prosody curves.
   */
  async _autoMatchVoiceAndControls(profile, clipName, text) {
    const voices = this.voiceManager.getVoices();

    // 1. Determine Target Language
    let targetLang = 'en-IN';
    if (this.controls.speakInLang && this.controls.speakInLang !== 'auto') {
      targetLang = this.controls.speakInLang;
    } else if (text && /[\u0900-\u097F]/.test(text)) {
      targetLang = 'hi-IN';
    } else {
      const userLang = (navigator.language || 'en-US');
      targetLang = userLang.startsWith('en') ? 'en-IN' : userLang;
    }

    // 2. Target Gender from Safe Zone Classification or Manual Override (Fix 2, Fix 3)
    let targetGender = 'female';
    if (this.manualClipGenderOverride && this.manualClipGenderOverride !== 'auto') {
      targetGender = this.manualClipGenderOverride;
    } else if (profile.voice_type === 'male') {
      targetGender = 'male';
    } else if (profile.voice_type === 'child_like') {
      targetGender = 'female';
    } else if (profile.voice_type === 'uncertain') {
      // Default to closest median boundary (165Hz) if still auto
      targetGender = profile.f0_median_hz < 165 ? 'male' : 'female';
    } else {
      targetGender = 'female';
    }

    // 3. Score Installed Voices (Fix 1, Fix 3)
    let bestVoice = null;
    let highestScore = -999;
    let bestReason = '';

    voices.forEach(voice => {
      let score = 0;
      const reasons = [];

      // Language match (+50 exact, +35 prefix)
      const vLang = voice.lang.toLowerCase();
      const tLang = targetLang.toLowerCase();
      if (vLang === tLang || vLang.replace('_', '-') === tLang.replace('_', '-')) {
        score += 50;
        reasons.push(targetLang);
      } else if (vLang.startsWith(tLang.split('-')[0])) {
        score += 35;
        reasons.push(tLang.split('-')[0]);
      }

      // Gender scoring (+40 match, -40 opposite gender) (Fix 1, Fix 3)
      const voiceGender = getVoiceGender(voice);
      if (voiceGender === targetGender) {
        score += 40;
        reasons.push(`${targetGender === 'male' ? '♂' : '♀'} matches clip`);
      } else if (voiceGender !== 'unknown' && voiceGender !== targetGender) {
        score -= 40;
      }

      // Natural/Enhanced (+15)
      const isNatural = /natural|online|neural|enhanced|premium/i.test(voice.name);
      if (isNatural) {
        score += 15;
        reasons.push('natural');
      }

      // Local service (+5)
      if (voice.localService) {
        score += 5;
      }

      // Cloud voice that ignores pitch/rate penalty (-30)
      const calib = this._getVoiceCalibration(voice, targetLang);
      const ignoresPitch = (calib && calib.ignoresPitch) || this.voiceManager.hasLimitedModulation(voice);
      if (ignoresPitch) {
        score -= 30;
      }

      if (score > highestScore) {
        highestScore = score;
        bestVoice = voice;
        bestReason = `${voice.name} — ${reasons.join(', ')}`;
      }
    });

    if (bestVoice) {
      this.selectedVoice = bestVoice;
      if (this.elements.voiceSelect) {
        this.elements.voiceSelect.value = bestVoice.voiceURI || bestVoice.name;
      }
      this._updateVoiceGenderOverrideUI();
      this._checkCloudVoiceWarning();
    }

    // 4. Chosen Voice Calibration & Pitch/Rate Mapping (Fix 3, Fix 4)
    const chosenGender = bestVoice ? getVoiceGender(bestVoice) : targetGender;
    const voiceCalib = this._getVoiceCalibration(bestVoice, targetLang);
    const defaultVoiceBase = chosenGender === 'male' ? 115 : (chosenGender === 'female' ? 205 : 160);
    const voiceBaseF0 = (voiceCalib && voiceCalib.baseF0) || defaultVoiceBase;
    const voiceK = (voiceCalib && voiceCalib.k) || 1.0;

    // Calibrate differential speaking rate (Fix 4)
    const voiceSps = (voiceCalib && voiceCalib.sps) || await this._calibrateVoiceSps(bestVoice, targetLang);

    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

    // Browser pitch response: pitch = (clipF0 / voiceBaseF0)^(1 / k), bounded to +/- 5 semitones [0.75, 1.33] (Fix 3)
    const pitchMin = Math.pow(2, -5 / 12); // ~0.74915
    const pitchMax = Math.pow(2, 5 / 12);  // ~1.33484
    const rawPitch = Math.pow(profile.f0_median_hz / voiceBaseF0, 1.0 / voiceK);
    const computedPitch = clamp(rawPitch, pitchMin, pitchMax);

    const computedRate = clamp(profile.syllables_per_sec / voiceSps, 0.6, 1.8);
    const computedPause = clamp(profile.pause_p90_ms || 300, 150, 1200);
    const computedPitchJitter = clamp(Math.round(8 + ((profile.f0_std_semitones - 1.5) / 3.5) * 30), 5, 45);
    const computedSpeedJitter = clamp(Math.round(profile.rate_variability * 60), 5, 30);
    const computedEmphasis = clamp(Number((profile.loudness_std_db / 12).toFixed(2)), 0.15, 0.8);
    const computedIntensity = clamp(Number((0.4 + ((profile.f0_std_semitones - 1.5) / 3.5) * 0.55).toFixed(2)), 0.4, 1.0);

    // 5. Unbiased Prosody Curve Selection based on Clip Style (Fix 6)
    let curveProfile = 'neutral';
    if (profile.f0_std_semitones > 4.0) {
      curveProfile = 'dynamic_peaks';
    } else if (profile.f0_std_semitones < 2.0) {
      curveProfile = 'neutral';
    } else if (profile.syllables_per_sec < 3.5 && (profile.pause_p90_ms || 300) > 450) {
      curveProfile = 'gentle_fall';
    } else {
      curveProfile = 'neutral';
    }

    // 6. Gender Mismatch Warning Banner (Fix 3)
    if (this.elements.genderMismatchWarning && this.elements.genderMismatchText) {
      if (chosenGender !== 'unknown' && chosenGender !== targetGender) {
        this.elements.genderMismatchWarning.style.display = 'flex';
        const isHindi = targetLang.startsWith('hi');
        const langName = isHindi ? 'Hindi' : 'English';
        if (targetGender === 'male') {
          this.elements.genderMismatchText.textContent = `No male ${langName} voice installed — results will sound female. Install Microsoft Hemant (Windows Settings → Time & language → Speech → Add voices) or use Microsoft Edge (Madhur Online).`;
        } else {
          this.elements.genderMismatchText.textContent = `No female ${langName} voice installed — results will sound male. Install Microsoft Kalpana / Swara (Windows Settings → Time & language → Speech → Add voices) or use Microsoft Edge.`;
        }
      } else {
        this.elements.genderMismatchWarning.style.display = 'none';
      }
    }

    const autoParams = {
      pitch: Number(computedPitch.toFixed(2)),
      rate: Number(computedRate.toFixed(2)),
      pauseLength: Math.round(computedPause),
      variationPitch: computedPitchJitter,
      variationRate: computedSpeedJitter,
      emphasisStrength: computedEmphasis,
      humanizeIntensity: computedIntensity,
      humanizeEnabled: true,
      volume: 1.0
    };

    this.autoMatchedParams = autoParams;
    this._applyAutoParams(autoParams);

    // 7. Save Custom Preset "Matched: <clip name>" (Fix 7)
    const matchedPreset = {
      id: 'matched_' + Date.now(),
      name: `Matched: ${clipName}`,
      icon: '🎙️',
      description: `Auto-matched from clip: ${bestReason}`,
      isCustom: true,
      isAutoMatched: true,
      voiceURI: bestVoice ? (bestVoice.voiceURI || bestVoice.name) : null,
      voiceType: targetGender,
      lang: targetLang,
      clipF0: profile.f0_median_hz,
      curveProfile: curveProfile,
      ...autoParams
    };
    this.presetManager.saveMatchedVoicePreset(matchedPreset);
    Storage.saveCustomPresets(this.presetManager.customPresets);
    this.activePresetId = matchedPreset.id;
    this._initPresetsUI();

    return { voice: bestVoice, reason: bestReason };
  }

  // Voice Calibration Helpers (Fix 4)
  _clearLegacySpsCache() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('humanvoice_sps_')) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  }

  _getAllCalibrations() {
    try {
      const raw = localStorage.getItem('humanvoice_voice_calib_v2');
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  _getVoiceCalibration(voice, langCode = 'en') {
    if (!voice) return null;
    const all = this._getAllCalibrations();
    const langKey = (langCode || 'en').split(/[-_]/)[0].toLowerCase();
    const key = (voice.voiceURI || voice.name) + '::' + langKey;
    return all[key] || all[voice.voiceURI || voice.name] || null;
  }

  _saveVoiceCalibration(voice, langCode, patch) {
    if (!voice) return;
    const all = this._getAllCalibrations();
    const langKey = (langCode || 'en').split(/[-_]/)[0].toLowerCase();
    const key = (voice.voiceURI || voice.name) + '::' + langKey;
    all[key] = {
      ...(all[key] || {}),
      ...patch,
      voiceURI: voice.voiceURI || voice.name,
      lang: langKey,
      measuredAt: Date.now()
    };
    try {
      localStorage.setItem('humanvoice_voice_calib_v2', JSON.stringify(all));
    } catch (e) {}
  }

  _timeSilentUtterance(voice, text) {
    return new Promise((resolve) => {
      let resolved = false;
      const utt = new SpeechSynthesisUtterance(text);
      utt.voice = voice;
      utt.volume = 0;
      utt.rate = 1.0;

      let startTime = 0;
      utt.onstart = () => {
        startTime = performance.now();
      };
      utt.onend = () => {
        if (resolved) return;
        resolved = true;
        const dur = (performance.now() - startTime) / 1000;
        resolve(dur);
      };
      utt.onerror = () => {
        if (resolved) return;
        resolved = true;
        resolve(1.5);
      };
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          window.speechSynthesis.cancel();
          resolve(2.0);
        }
      }, 7000);

      window.speechSynthesis.speak(utt);
    });
  }

  /**
   * Rate calibration: measures sps = (syl2 - syl1) / (t2 - t1) to cancel start delay (Fix 4)
   */
  async _calibrateVoiceSps(voice, targetLang = 'en') {
    if (!voice) return 4.2;
    this._clearLegacySpsCache();

    const isHindi = targetLang.startsWith('hi') || (voice.lang && voice.lang.toLowerCase().startsWith('hi'));
    const s1 = isHindi ? 'मानव वाणी में लय है।' : 'Natural human speech.';
    const s2 = isHindi
      ? 'मानव वाणी में स्वाभाविक लय और मधुरता होती है।'
      : 'Natural human speech has melody and rhythm. The weather today is wonderfully pleasant and warm.';

    const syl1 = isHindi ? countHindiSyllables(s1) : countEnglishSyllables(s1);
    const syl2 = isHindi ? countHindiSyllables(s2) : countEnglishSyllables(s2);

    const existingCalib = this._getVoiceCalibration(voice, targetLang);
    if (existingCalib && existingCalib.sps) {
      return existingCalib.sps;
    }

    const t1 = await this._timeSilentUtterance(voice, s1);
    const t2 = await this._timeSilentUtterance(voice, s2);

    let sps = 4.2;
    const dt = t2 - t1;
    const dsyl = syl2 - syl1;
    if (dt > 0.4 && dsyl > 0) {
      sps = Math.max(2.5, Math.min(7.0, dsyl / dt));
    } else if (t2 > 0.5) {
      sps = Math.max(2.5, Math.min(7.0, syl2 / t2));
    }

    sps = Number(sps.toFixed(2));
    this._saveVoiceCalibration(voice, targetLang, { sps });
    return sps;
  }

  /**
   * Tab-Audio Pitch & Speed Calibration (Fix 4 - "🎯 Calibrate this voice")
   */
  async _handleCalibrateVoice(voice) {
    if (!voice) return;
    const progressEl = this.elements.calibrationProgress;
    const progressText = this.elements.calibrationProgressText;
    const calibBtn = this.elements.calibrateVoiceBtn;

    if (progressEl) progressEl.style.display = 'flex';
    if (calibBtn) calibBtn.classList.add('calibrating');
    if (progressText) progressText.textContent = `Calibrating "${voice.name}"… measuring syllable pacing…`;

    try {
      // 1. Measure differential rate first
      const targetLang = voice.lang || 'en';
      const sps = await this._calibrateVoiceSps(voice, targetLang);

      // 2. Measure Pitch Response (k) & Base F0 via Tab Audio Capture if permitted
      let baseF0 = getVoiceGender(voice) === 'male' ? 115 : (getVoiceGender(voice) === 'female' ? 205 : 160);
      let k = 1.0;

      if (progressText) progressText.textContent = `Measuring pitch response (k) and base frequency…`;

      let capturedStream = null;
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
          capturedStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          });
          // Immediately kill video track; only audio is needed
          capturedStream.getVideoTracks().forEach(t => t.stop());
        }
      } catch (e) {
        console.warn('Tab audio capture cancelled or not granted:', e.message);
      }

      if (capturedStream && capturedStream.getAudioTracks().length > 0) {
        const audioTrack = capturedStream.getAudioTracks()[0];
        const recordPitchSample = (pitchVal) => {
          return new Promise((resolve) => {
            const recorder = new MediaRecorder(new MediaStream([audioTrack]));
            const chunks = [];
            recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
            recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }));

            const utt = new SpeechSynthesisUtterance('Natural speech melody.');
            utt.voice = voice;
            utt.pitch = pitchVal;
            utt.rate = 1.0;
            utt.volume = 1.0;

            recorder.start();
            utt.onend = () => {
              setTimeout(() => {
                if (recorder.state !== 'inactive') recorder.stop();
              }, 200);
            };
            utt.onerror = () => {
              if (recorder.state !== 'inactive') recorder.stop();
            };
            window.speechSynthesis.speak(utt);
          });
        };

        const blob08 = await recordPitchSample(0.8);
        const blob10 = await recordPitchSample(1.0);
        const blob125 = await recordPitchSample(1.25);

        capturedStream.getTracks().forEach(t => t.stop());

        const prof08 = await this.voiceMatcher.analyze(blob08);
        const prof10 = await this.voiceMatcher.analyze(blob10);
        const prof125 = await this.voiceMatcher.analyze(blob125);

        if (prof10.f0_median_hz > 60) {
          baseF0 = prof10.f0_median_hz;
        }

        if (prof125.f0_median_hz > 60 && prof08.f0_median_hz > 60) {
          k = Math.log(prof125.f0_median_hz / prof08.f0_median_hz) / Math.log(1.25 / 0.8);
        }
      }

      const ignoresPitch = k < 0.1;
      this._saveVoiceCalibration(voice, targetLang, {
        baseF0: Math.round(baseF0),
        k: Number(k.toFixed(2)),
        sps: Number(sps.toFixed(2)),
        ignoresPitch
      });

      // Show calibrated values in banner
      if (this.elements.voiceCalibStatsBanner && this.elements.voiceCalibStatsText) {
        this.elements.voiceCalibStatsBanner.style.display = 'block';
        this.elements.voiceCalibStatsText.textContent = `Voice base ${Math.round(baseF0)} Hz · pitch response k=${Number(k).toFixed(2)}${ignoresPitch ? ' (ignores pitch)' : ''} · ${Number(sps).toFixed(1)} syl/s`;
      }

      this._setStatus(`Voice "${voice.name}" calibrated: base ${Math.round(baseF0)} Hz, k=${Number(k).toFixed(2)}, ${Number(sps).toFixed(1)} syl/s`, 'ready');
    } catch (e) {
      console.warn('Voice calibration error:', e);
      this._setStatus(`Voice calibration completed with standard defaults.`, 'ready');
    } finally {
      if (progressEl) progressEl.style.display = 'none';
      if (calibBtn) calibBtn.classList.remove('calibrating');
    }
  }

  _displayProfileFingerprint(profile, voice = null, reason = '') {
    if (!profile) return;
    if (this.elements.profileFingerprintPanel) this.elements.profileFingerprintPanel.style.display = 'block';

    if (this.elements.statF0) this.elements.statF0.textContent = `${profile.f0_median_hz} Hz`;
    if (this.elements.statSps) {
      const wpm = Math.round((profile.syllables_per_sec * 60) / 1.5);
      this.elements.statSps.textContent = `${profile.syllables_per_sec} sps (~${wpm} wpm)`;
    }
    if (this.elements.statExpressiveness) {
      const pct = Math.min(100, Math.round((profile.f0_std_semitones / 5.0) * 100));
      this.elements.statExpressiveness.textContent = `${pct}%`;
    }

    // Voice Type safe-zone & toggle UI (Fix 2)
    const isOverridden = this.manualClipGenderOverride && this.manualClipGenderOverride !== 'auto';
    const effectiveType = isOverridden ? this.manualClipGenderOverride : profile.voice_type;
    const typeTitle = effectiveType === 'child_like' ? 'Child-like' : (effectiveType === 'male' ? 'Male' : (effectiveType === 'female' ? 'Female' : 'Uncertain'));
    const confPct = Math.round((profile.voice_type_confidence || 0.8) * 100);
    const modeLabel = isOverridden ? 'manual' : 'auto';

    if (this.elements.voiceTypeLabel) {
      this.elements.voiceTypeLabel.textContent = `Voice type: ${typeTitle} (${modeLabel}, ${confPct}%)`;
    }

    // Update 3-way toggle active state
    ['genderToggleAuto', 'genderToggleMale', 'genderToggleFemale'].forEach(id => {
      const btn = this.elements[id];
      if (btn) {
        const g = btn.dataset.gender;
        const isActive = (this.manualClipGenderOverride || 'auto') === g;
        btn.className = `btn-gender-toggle ${isActive ? 'active' : ''} ${isActive && g === 'male' ? 'active-male' : ''} ${isActive && g === 'female' ? 'active-female' : ''}`;
      }
    });

    // Uncertain notice & amber glow (Fix 2)
    const isUncertain = profile.voice_type === 'uncertain' && !isOverridden;
    if (this.elements.voiceTypeUncertainNotice) {
      this.elements.voiceTypeUncertainNotice.style.display = isUncertain ? 'block' : 'none';
    }
    if (this.elements.clipGenderToggleGroup) {
      this.elements.clipGenderToggleGroup.classList.toggle('highlight-uncertain', isUncertain);
    }

    // Calibrated Voice Readout (Fix 4)
    if (voice && this.elements.voiceCalibStatsBanner && this.elements.voiceCalibStatsText) {
      const calib = this._getVoiceCalibration(voice, voice.lang);
      const vGender = getVoiceGender(voice);
      const baseF0 = (calib && calib.baseF0) || (vGender === 'male' ? 115 : (vGender === 'female' ? 205 : 160));
      const k = (calib && calib.k) || 1.0;
      const sps = (calib && calib.sps) || 4.2;
      this.elements.voiceCalibStatsBanner.style.display = 'block';
      this.elements.voiceCalibStatsText.textContent = `Voice base ${Math.round(baseF0)} Hz · pitch response k=${Number(k).toFixed(2)}${calib && calib.ignoresPitch ? ' (ignores pitch)' : ''} · ${Number(sps).toFixed(1)} syl/s`;
    }

    if (this.elements.qualityScoreBadge) {
      const score = profile.quality_score;
      this.elements.qualityScoreBadge.textContent = `Score: ${score}/100`;
      this.elements.qualityScoreBadge.className = `quality-score-badge ${score >= 80 ? 'high' : (score >= 60 ? 'medium' : 'low')}`;
    }

    if (this.elements.matchedVoiceReason && reason) {
      this.elements.matchedVoiceReason.style.display = 'block';
      this.elements.matchedVoiceReason.textContent = `Auto-Selected: ${reason}`;
    }

    if (this.elements.profileWarningsList && profile.warnings) {
      this.elements.profileWarningsList.innerHTML = profile.warnings.map(w => `<div>⚠️ ${w}</div>`).join('');
    }
  }

  async _playOriginalReferenceClip() {
    if (this.activeOriginalAudio) {
      this.activeOriginalAudio.pause();
      this.activeOriginalAudio.currentTime = 0;
      this.activeOriginalAudio = null;
      if (this.elements.playOriginalRefBtn) this.elements.playOriginalRefBtn.classList.remove('playing');
      return;
    }

    let blob = this.uploadedAudioBlob;
    if (!blob && this.storedClipId) {
      blob = await ClipStore.getClip(this.storedClipId);
    }

    if (!blob) {
      alert('No reference audio clip found. Please upload or record a clip.');
      return;
    }

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.activeOriginalAudio = audio;

    if (this.elements.playOriginalRefBtn) this.elements.playOriginalRefBtn.classList.add('playing');

    audio.onended = () => {
      this.activeOriginalAudio = null;
      if (this.elements.playOriginalRefBtn) this.elements.playOriginalRefBtn.classList.remove('playing');
      URL.revokeObjectURL(url);
    };

    audio.onerror = () => {
      this.activeOriginalAudio = null;
      if (this.elements.playOriginalRefBtn) this.elements.playOriginalRefBtn.classList.remove('playing');
      URL.revokeObjectURL(url);
    };

    audio.play();
  }

  _playBrowserMatchSample() {
    // Stop any playing original clip
    if (this.activeOriginalAudio) {
      this.activeOriginalAudio.pause();
      this.activeOriginalAudio.currentTime = 0;
      this.activeOriginalAudio = null;
      if (this.elements.playOriginalRefBtn) this.elements.playOriginalRefBtn.classList.remove('playing');
    }

    const editorText = this.elements.textInput ? this.elements.textInput.value.trim() : '';
    const sentences = editorText ? this.prosodyEngine.splitIntoSentences(editorText) : [];
    const sampleText = sentences.length > 0
      ? sentences[0].rawSentence
      : 'Natural human speech has expressive melody and rhythm.';

    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(this.prosodyEngine.stripFormatting(sampleText));
    utt.voice = this.selectedVoice;
    utt.pitch = this.controls.pitch;
    utt.rate = this.controls.rate;
    utt.volume = this.controls.volume;

    if (this.elements.playBrowserMatchBtn) this.elements.playBrowserMatchBtn.classList.add('playing');
    utt.onend = () => {
      if (this.elements.playBrowserMatchBtn) this.elements.playBrowserMatchBtn.classList.remove('playing');
    };
    utt.onerror = () => {
      if (this.elements.playBrowserMatchBtn) this.elements.playBrowserMatchBtn.classList.remove('playing');
    };

    window.speechSynthesis.speak(utt);
  }

  _initSpeedControls() {
    // Quick speed pills (0.75x, 1x, 1.25x, 1.5x, 2x)
    document.querySelectorAll('.btn-speed-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const speed = parseFloat(btn.dataset.speed);
        this._setSpeed(speed);
      });
    });
  }

  _setSpeed(speed) {
    const clamped = Math.max(0.5, Math.min(2.0, parseFloat(speed.toFixed(2))));
    this.controls.rate = clamped;
    if (this.elements.rateSlider) {
      this.elements.rateSlider.value = clamped;
      if (this.elements.rateValue) this.elements.rateValue.textContent = clamped.toFixed(2) + 'x';
    }
    this._markChipManual('chipSpeed');
    this._updateSpeedPillsUI(clamped);
    this._saveCurrentState();
    this._updateTextStats();

    // If actively speaking, restart immediately from current word boundary (Step 5)
    if (this.playbackState === 'SPEAKING' && this.activeUtterance) {
      clearTimeout(this.speedChangeDebounceTimer);
      this.speedChangeDebounceTimer = setTimeout(() => {
        this._restartCurrentChunkAtNewRate();
      }, 150);
    }
  }

  _adjustSpeed(delta) {
    this._setSpeed(this.controls.rate + delta);
  }

  _updateSpeedPillsUI(currentRate) {
    document.querySelectorAll('.btn-speed-pill').forEach(btn => {
      const pillVal = parseFloat(btn.dataset.speed);
      btn.classList.toggle('active', Math.abs(pillVal - currentRate) < 0.03);
    });
  }
}

// Bootstrap application on DOM load
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('DOMContentLoaded', () => {
    const app = new HumanVoiceApp();
    app.init();
    window.HumanVoice = app; // Accessible for debugging
  });
}
