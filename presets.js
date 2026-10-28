/**
 * HumanVoice Studio - Presets Module
 * Built-in emotion and tone presets engineered via prosody parameters,
 * plus custom preset management.
 */

export const BUILT_IN_PRESETS = [
  {
    id: 'neutral',
    name: 'Neutral',
    icon: '⚖️',
    description: 'Balanced, standard conversational cadence. Natural declination and subtle variation.',
    pitch: 1.0,
    rate: 1.0,
    volume: 1.0,
    pauseLength: 300,
    variationPitch: 12,
    variationRate: 10,
    emphasisStrength: 0.35,
    humanizeEnabled: true,
    humanizeIntensity: 0.7,
    curveProfile: 'neutral'
  },
  {
    id: 'friendly',
    name: 'Friendly',
    icon: '😊',
    description: 'Warm, approachable tone. Slightly elevated pitch, moderate pace, and playful inflection rises.',
    pitch: 1.15,
    rate: 1.08,
    volume: 1.0,
    pauseLength: 260,
    variationPitch: 25,
    variationRate: 18,
    emphasisStrength: 0.45,
    humanizeEnabled: true,
    humanizeIntensity: 0.85,
    curveProfile: 'warm_rise'
  },
  {
    id: 'excited',
    name: 'Excited',
    icon: '⚡',
    description: 'High energy and enthusiastic! Upbeat tempo, noticeable pitch peaks, and punchy emphasis.',
    pitch: 1.35,
    rate: 1.25,
    volume: 1.0,
    pauseLength: 180,
    variationPitch: 40,
    variationRate: 30,
    emphasisStrength: 0.65,
    humanizeEnabled: true,
    humanizeIntensity: 1.0,
    curveProfile: 'dynamic_peaks'
  },
  {
    id: 'calm',
    name: 'Calm / Soothing',
    icon: '🌿',
    description: 'Relaxed, gentle delivery. Slower rate, slightly lower pitch, smoothed transitions, and spacious pauses.',
    pitch: 0.92,
    rate: 0.88,
    volume: 0.85,
    pauseLength: 550,
    variationPitch: 10,
    variationRate: 8,
    emphasisStrength: 0.2,
    humanizeEnabled: true,
    humanizeIntensity: 0.6,
    curveProfile: 'gentle_fall'
  },
  {
    id: 'sad',
    name: 'Sad / Melancholy',
    icon: '🌧️',
    description: 'Subdued and hesitant. Dropped pitch, sluggish rate, reduced volume, and drooping sentence endings.',
    pitch: 0.82,
    rate: 0.82,
    volume: 0.75,
    pauseLength: 600,
    variationPitch: 15,
    variationRate: 12,
    emphasisStrength: 0.15,
    humanizeEnabled: true,
    humanizeIntensity: 0.75,
    curveProfile: 'subdued_flat'
  },
  {
    id: 'angry',
    name: 'Angry / Intense',
    icon: '🔥',
    description: 'Forceful and staccato. Elevated volume and pitch, clipped pauses, aggressive stress on key words.',
    pitch: 1.22,
    rate: 1.18,
    volume: 1.0,
    pauseLength: 150,
    variationPitch: 35,
    variationRate: 25,
    emphasisStrength: 0.75,
    humanizeEnabled: true,
    humanizeIntensity: 0.9,
    curveProfile: 'sharp_attack'
  },
  {
    id: 'whisper',
    name: 'Whisper-like',
    icon: '🤫',
    description: 'Intimate and breathy simulation: low volume, deliberate slow pace, lower pitch, and careful pauses.',
    pitch: 0.85,
    rate: 0.85,
    volume: 0.35,
    pauseLength: 450,
    variationPitch: 8,
    variationRate: 10,
    emphasisStrength: 0.25,
    humanizeEnabled: true,
    humanizeIntensity: 0.5,
    curveProfile: 'whisper'
  },
  {
    id: 'news_anchor',
    name: 'News Anchor',
    icon: '🎙️',
    description: 'Polished, authoritative broadcast cadence. Consistent tempo, crisp clause boundaries, regulated emphasis.',
    pitch: 1.04,
    rate: 1.12,
    volume: 1.0,
    pauseLength: 320,
    variationPitch: 14,
    variationRate: 8,
    emphasisStrength: 0.4,
    humanizeEnabled: true,
    humanizeIntensity: 0.65,
    curveProfile: 'authoritative'
  },
  {
    id: 'storyteller',
    name: 'Storyteller',
    icon: '📖',
    description: 'Expressive audiobook delivery. Rich dynamics, dramatic pauses, narrative pacing, and sentence suspense.',
    pitch: 0.98,
    rate: 0.95,
    volume: 0.95,
    pauseLength: 500,
    variationPitch: 32,
    variationRate: 28,
    emphasisStrength: 0.55,
    humanizeEnabled: true,
    humanizeIntensity: 0.95,
    curveProfile: 'story_cadence'
  },
  {
    id: 'robot',
    name: 'Robot / Synthesizer',
    icon: '🤖',
    description: 'Pure synthetic mechanical delivery. Zero pitch/rate jitter, monotone pitch, and robotic uniform spacing.',
    pitch: 1.0,
    rate: 1.0,
    volume: 1.0,
    pauseLength: 200,
    variationPitch: 0,
    variationRate: 0,
    emphasisStrength: 0.0,
    humanizeEnabled: false,
    humanizeIntensity: 0.0,
    curveProfile: 'robotic_quantized'
  },
  {
    id: 'child_like',
    name: 'Child-like',
    icon: '🎈',
    description: 'Playful, curious, and animated. Bright high pitch, lively tempo, and pronounced curiosity contours.',
    pitch: 1.48,
    rate: 1.12,
    volume: 0.95,
    pauseLength: 220,
    variationPitch: 35,
    variationRate: 22,
    emphasisStrength: 0.5,
    humanizeEnabled: true,
    humanizeIntensity: 0.85,
    curveProfile: 'energetic_high'
  },
  {
    id: 'deep_narrator',
    name: 'Deep Narrator',
    icon: '🎬',
    description: 'Resonant movie-trailer voice. Deep low pitch, weighty steady tempo, and cinematic pauses.',
    pitch: 0.68,
    rate: 0.9,
    volume: 1.0,
    pauseLength: 600,
    variationPitch: 12,
    variationRate: 10,
    emphasisStrength: 0.5,
    humanizeEnabled: true,
    humanizeIntensity: 0.7,
    curveProfile: 'deep_chest'
  }
];

export class PresetManager {
  constructor(customPresets = []) {
    this.customPresets = customPresets;
  }

  getAllPresets() {
    return [...BUILT_IN_PRESETS, ...this.customPresets];
  }

  getPresetById(id) {
    return this.getAllPresets().find(p => p.id === id) || null;
  }

  saveCustomPreset(preset) {
    const existingIndex = this.customPresets.findIndex(p => p.id === preset.id);
    if (existingIndex >= 0) {
      this.customPresets[existingIndex] = preset;
    } else {
      this.customPresets.push(preset);
    }
    return this.customPresets;
  }

  /**
   * Save or update an auto-matched voice preset from reference clip analysis
   */
  saveMatchedVoicePreset(matchedPreset) {
    return this.saveCustomPreset({
      ...matchedPreset,
      isCustom: true,
      isAutoMatched: true
    });
  }

  deleteCustomPreset(id) {
    this.customPresets = this.customPresets.filter(p => p.id !== id);
    return this.customPresets;
  }
}
