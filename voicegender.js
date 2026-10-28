/**
 * HumanVoice Studio - Voice Gender Detection Module
 * Token-based voice speaker first-name matching with Chrome Google voice exceptions
 * and localStorage manual override support.
 */

const OVERRIDES_STORAGE_KEY = 'humanvoice_voice_gender_overrides';

export const FEMALE_NAMES = new Set([
  'swara', 'kalpana', 'neerja', 'heera', 'ananya', 'aashi', 'kavya', 'aria',
  'jenny', 'ava', 'emma', 'michelle', 'ana', 'zira', 'samantha', 'victoria',
  'karen', 'moira', 'tessa', 'fiona', 'veena', 'lekha', 'sonia', 'libby',
  'maisie', 'hazel', 'susan', 'natasha', 'clara', 'christel', 'katja', 'amala',
  'denise', 'elvira', 'isabella', 'maria', 'alexandra', 'paulina', 'sabina',
  'hortense', 'julie', 'nanami', 'xiaoxiao', 'sun-hi', 'sun'
]);

export const MALE_NAMES = new Set([
  'madhur', 'hemant', 'prabhat', 'ravi', 'aarav', 'kunal', 'rehaan', 'arjun',
  'guy', 'andrew', 'brian', 'christopher', 'eric', 'roger', 'steffan', 'davis',
  'tony', 'jason', 'david', 'mark', 'james', 'george', 'ryan', 'thomas',
  'alfie', 'elliot', 'william', 'daniel', 'alex', 'fred', 'rishi', 'aaron',
  'conrad', 'henri', 'alvaro', 'diego', 'keita', 'yunxi'
]);

/**
 * Extracts speaker first name token from raw voice name
 * Strips Microsoft / Google / Apple prefixes, descriptors, and trailing language/country parts.
 * @param {string} rawName 
 * @returns {string} token
 */
export function extractSpeakerFirstName(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';

  // 1. Cut off language/country suffix after ' - '
  let cleaned = rawName.split(/\s+-\s+/)[0];

  // 2. Strip vendor names at start
  cleaned = cleaned.replace(/^(Microsoft|Google|Apple)\s+/i, '');

  // 3. Strip common descriptors / parentheticals
  cleaned = cleaned
    .replace(/\((Natural|Online|Enhanced|Neural|Expressive|Multilingual|Desktop)\)/gi, '')
    .replace(/\b(Online|Natural|Enhanced|Neural|Expressive|Multilingual|Desktop)\b/gi, '')
    .trim();

  // 4. Extract first token (preserve hyphenated names like Sun-Hi)
  const tokens = cleaned.split(/[\s_()/]+/).filter(t => t.length > 0);
  return tokens.length > 0 ? tokens[0].toLowerCase() : '';
}

/**
 * Reads all manual voice gender overrides from localStorage
 * @returns {Object.<string, 'male'|'female'|'unknown'>}
 */
export function getAllVoiceGenderOverrides() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(OVERRIDES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('Failed to parse voice gender overrides:', e);
    return {};
  }
}

/**
 * Gets gender override for a specific voice URI or name
 * @param {string} voiceURI 
 * @returns {'male'|'female'|'unknown'|null}
 */
export function getVoiceGenderOverride(voiceURI) {
  if (!voiceURI) return null;
  const overrides = getAllVoiceGenderOverrides();
  return overrides[voiceURI] || null;
}

/**
 * Saves or updates gender override for a specific voice
 * @param {string} voiceURI 
 * @param {'male'|'female'|'unknown'|null} gender 
 */
export function setVoiceGenderOverride(voiceURI, gender) {
  if (!voiceURI) return;
  if (typeof localStorage === 'undefined') return;
  const overrides = getAllVoiceGenderOverrides();
  if (gender === null || gender === 'auto') {
    delete overrides[voiceURI];
  } else {
    overrides[voiceURI] = gender;
  }
  try {
    localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(overrides));
  } catch (e) {
    console.warn('Failed to save voice gender override:', e);
  }
}

/**
 * Detects voice gender ('male' | 'female' | 'unknown')
 * Follows precedence:
 * 1. Manual user override in localStorage
 * 2. Explicit 'Female' or 'Male' word in the voice name
 * 3. Specific Chrome Google cloud voice rules
 * 4. Speaker first name token matched against FEMALE_NAMES / MALE_NAMES
 * @param {SpeechSynthesisVoice|{name: string, voiceURI?: string}|string} voice 
 * @returns {'male'|'female'|'unknown'}
 */
export function getVoiceGender(voice) {
  if (!voice) return 'unknown';

  const rawName = typeof voice === 'string' ? voice : (voice.name || '');
  const voiceURI = typeof voice === 'object' && voice ? (voice.voiceURI || voice.name || '') : rawName;

  // 1. Manual override check
  const override = getVoiceGenderOverride(voiceURI) || getVoiceGenderOverride(rawName);
  if (override && (override === 'male' || override === 'female' || override === 'unknown')) {
    return override;
  }

  // 2. Explicit words 'Female' or 'Male' (word boundary, case-insensitive)
  if (/\b(female|woman)\b/i.test(rawName)) {
    return 'female';
  }
  if (/\b(male|man)\b/i.test(rawName)) {
    return 'male';
  }

  // 3. Chrome Google voices specific map
  const trimmedName = rawName.trim();
  if (/^Google\s+हिन्दी/i.test(trimmedName)) {
    return 'female';
  }
  if (/^Google\s+US\s+English\b/i.test(trimmedName)) {
    return 'female';
  }
  if (/^Google\s+UK\s+English\s+Female\b/i.test(trimmedName)) {
    return 'female';
  }
  if (/^Google\s+UK\s+English\s+Male\b/i.test(trimmedName)) {
    return 'male';
  }
  if (/^Google\s+/i.test(trimmedName)) {
    // Any other "Google ..." cloud voices with generic labels are unknown
    return 'unknown';
  }

  // 4. Tokenize first name only
  const firstName = extractSpeakerFirstName(rawName);
  if (!firstName) return 'unknown';

  if (FEMALE_NAMES.has(firstName)) {
    return 'female';
  }
  if (MALE_NAMES.has(firstName)) {
    return 'male';
  }

  return 'unknown';
}
