/**
 * HumanVoice Studio - Storage Module
 * Manages persisting settings and custom presets in localStorage,
 * with JSON export and import capabilities.
 */

const STORAGE_KEYS = {
  SETTINGS_V1: 'humanvoice_settings_v1',
  SETTINGS: 'humanvoice_settings_v2',
  CUSTOM_PRESETS: 'humanvoice_custom_presets_v1',
  THEME: 'humanvoice_theme_v1'
};

export const Storage = {
  /**
   * Save user control settings
   * @param {Object} settings 
   */
  saveSettings(settings) {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save settings to localStorage:', e);
    }
  },

  /**
   * Load user control settings with automatic v1 -> v2 migration
   * @returns {Object|null}
   */
  loadSettings() {
    try {
      // 1. Try loading v2 settings
      const v2Data = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (v2Data) {
        return JSON.parse(v2Data);
      }

      // 2. Fall back and migrate from v1 settings if present
      const v1Data = localStorage.getItem(STORAGE_KEYS.SETTINGS_V1);
      if (v1Data) {
        const v1Settings = JSON.parse(v1Data);
        const migratedSettings = {
          ...v1Settings,
          rate: v1Settings.rate || 1.0
        };
        // Remove obsolete server keys if any
        delete migratedSettings.engine;
        delete migratedSettings.activeVoiceId;
        delete migratedSettings.renderSpeed;
        delete migratedSettings.speedLinked;

        // Persist migrated v2 settings
        localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(migratedSettings));
        return migratedSettings;
      }

      return null;
    } catch (e) {
      console.warn('Failed to load settings from localStorage:', e);
      return null;
    }
  },

  /**
   * Save custom presets
   * @param {Array} presets 
   */
  saveCustomPresets(presets) {
    try {
      localStorage.setItem(STORAGE_KEYS.CUSTOM_PRESETS, JSON.stringify(presets));
    } catch (e) {
      console.warn('Failed to save custom presets:', e);
    }
  },

  /**
   * Load custom presets
   * @returns {Array}
   */
  loadCustomPresets() {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.CUSTOM_PRESETS);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.warn('Failed to load custom presets:', e);
      return [];
    }
  },

  /**
   * Save UI theme preference
   * @param {string} theme ('dark' | 'light' | 'system')
   */
  saveTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEYS.THEME, theme);
    } catch (e) {
      console.warn('Failed to save theme:', e);
    }
  },

  /**
   * Load UI theme preference
   * @returns {string}
   */
  loadTheme() {
    try {
      return localStorage.getItem(STORAGE_KEYS.THEME) || 'system';
    } catch (e) {
      return 'system';
    }
  },

  /**
   * Export all user configuration as downloadable JSON
   * @param {Object} currentSettings 
   * @param {Array} customPresets 
   * @returns {string}
   */
  exportConfigJSON(currentSettings, customPresets) {
    const payload = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      settings: currentSettings,
      customPresets: customPresets
    };
    return JSON.stringify(payload, null, 2);
  },

  /**
   * Parse and validate imported configuration JSON
   * @param {string} jsonString 
   * @returns {Object} { settings, customPresets }
   */
  importConfigJSON(jsonString) {
    try {
      const data = JSON.parse(jsonString);
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid JSON format');
      }
      return {
        settings: data.settings || null,
        customPresets: Array.isArray(data.customPresets) ? data.customPresets : []
      };
    } catch (err) {
      throw new Error('Configuration import failed: ' + err.message);
    }
  }
};
