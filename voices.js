/**
 * HumanVoice Studio - Voices Module
 * Asynchronous voice discovery, language grouping, cloud voice detection,
 * and preview player.
 */

export class VoiceManager {
  constructor() {
    this.voices = [];
    this.isLoaded = false;
    this.listeners = [];
  }

  /**
   * Initialize voices with onvoiceschanged handler and polling fallback
   * @returns {Promise<SpeechSynthesisVoice[]>}
   */
  init() {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) {
        console.warn('SpeechSynthesis API not supported by this browser.');
        resolve([]);
        return;
      }

      const checkVoices = () => {
        const loaded = window.speechSynthesis.getVoices();
        if (loaded && loaded.length > 0) {
          this.voices = loaded;
          this.isLoaded = true;
          this._notifyListeners();
          resolve(this.voices);
          return true;
        }
        return false;
      };

      if (checkVoices()) {
        return;
      }

      // 1. Listen for standard event
      window.speechSynthesis.onvoiceschanged = () => {
        checkVoices();
      };

      // 2. Fallback polling for browsers with delayed loading (Safari, Chrome edge cases)
      let attempts = 0;
      const pollInterval = setInterval(() => {
        attempts++;
        if (checkVoices() || attempts > 50) { // 5 seconds max
          clearInterval(pollInterval);
          if (!this.isLoaded) {
            this.voices = window.speechSynthesis.getVoices();
            this.isLoaded = this.voices.length > 0;
            this._notifyListeners();
            resolve(this.voices);
          }
        }
      }, 100);
    });
  }

  onVoicesLoaded(callback) {
    if (this.isLoaded) {
      callback(this.voices);
    } else {
      this.listeners.push(callback);
    }
  }

  _notifyListeners() {
    this.listeners.forEach(fn => fn(this.voices));
    this.listeners = [];
  }

  getVoices() {
    return this.voices;
  }

  /**
   * Find voice by URI or Name
   * @param {string} identifier 
   * @returns {SpeechSynthesisVoice|null}
   */
  findVoice(identifier) {
    if (!identifier) return null;
    return this.voices.find(v => v.voiceURI === identifier || v.name === identifier) || null;
  }

  /**
   * Detect the best default voice matching navigator.language
   * @returns {SpeechSynthesisVoice|null}
   */
  getBestDefaultVoice() {
    if (!this.voices || this.voices.length === 0) return null;

    // 1. Check if browser marked a default
    const browserDefault = this.voices.find(v => v.default);
    
    // 2. Match user's primary language (e.g. 'en-US' or 'en')
    const userLang = (navigator.language || 'en-US').toLowerCase();
    const exactLangMatch = this.voices.find(v => v.lang.toLowerCase() === userLang);
    const prefixLangMatch = this.voices.find(v => v.lang.toLowerCase().startsWith(userLang.split('-')[0]));

    // Prefer high quality / local / natural voices if available
    const naturalVoice = this.voices.find(v => 
      v.lang.toLowerCase().startsWith(userLang.split('-')[0]) && 
      (v.name.includes('Natural') || v.name.includes('Enhanced') || v.name.includes('Online (Natural)'))
    );

    return naturalVoice || exactLangMatch || browserDefault || prefixLangMatch || this.voices[0];
  }

  /**
   * Group voices by language display name
   * @param {boolean} currentLangOnly 
   * @param {string} searchQuery 
   * @returns {Object.<string, SpeechSynthesisVoice[]>}
   */
  getGroupedVoices(currentLangOnly = false, searchQuery = '') {
    const userLangPrefix = (navigator.language || 'en').split('-')[0].toLowerCase();
    const query = searchQuery.trim().toLowerCase();

    const filtered = this.voices.filter(voice => {
      // Filter by language prefix if currentLangOnly is true
      if (currentLangOnly) {
        const vLangPrefix = voice.lang.split(/[-_]/)[0].toLowerCase();
        if (vLangPrefix !== userLangPrefix) {
          return false;
        }
      }

      // Filter by search query
      if (query) {
        const nameMatch = voice.name.toLowerCase().includes(query);
        const langMatch = voice.lang.toLowerCase().includes(query);
        return nameMatch || langMatch;
      }

      return true;
    });

    // Group by friendly language label
    const grouped = {};
    filtered.forEach(voice => {
      const groupKey = this.getLanguageDisplayName(voice.lang);
      if (!grouped[groupKey]) {
        grouped[groupKey] = [];
      }
      grouped[groupKey].push(voice);
    });

    return grouped;
  }

  /**
   * Get human readable language label
   * @param {string} langCode 
   * @returns {string}
   */
  getLanguageDisplayName(langCode) {
    try {
      const langNames = new Intl.DisplayNames(['en'], { type: 'language' });
      const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
      
      const parts = langCode.replace('_', '-').split('-');
      const lang = langNames.of(parts[0]) || parts[0];
      const region = parts[1] ? regionNames.of(parts[1]) || parts[1] : '';

      return region ? `${lang} (${region})` : lang;
    } catch (e) {
      return langCode;
    }
  }

  /**
   * Detect whether a voice has limited modulation capability
   * E.g. Chrome's remote Google voices famously ignore pitch and rate property changes.
   * @param {SpeechSynthesisVoice} voice 
   * @returns {boolean}
   */
  hasLimitedModulation(voice) {
    if (!voice) return false;
    const name = voice.name.toLowerCase();
    // Known Chrome Desktop Google cloud voices that ignore pitch / rate
    const isGoogleCloud = name.startsWith('google ') && !voice.localService;
    return isGoogleCloud;
  }

  /**
   * Speak a short preview of the selected voice
   * @param {SpeechSynthesisVoice} voice 
   * @param {number} pitch 
   * @param {number} rate 
   */
  previewVoice(voice, pitch = 1.0, rate = 1.0) {
    if (!('speechSynthesis' in window) || !voice) return;

    window.speechSynthesis.cancel(); // Stop current speech
    const sampleText = `Hello! This is ${voice.name}. HumanVoice Studio gives me life.`;
    const utterance = new SpeechSynthesisUtterance(sampleText);
    utterance.voice = voice;
    utterance.pitch = Math.min(2, Math.max(0, pitch));
    utterance.rate = Math.min(2, Math.max(0.5, rate));
    utterance.volume = 1.0;

    window.speechSynthesis.speak(utterance);
  }
}
