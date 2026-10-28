/**
 * HumanVoice Studio - Prosody Engine
 * Splits text into sentences and phrases, applies prosody engineering
 * (pitch declination, question inflection, exclamation boosts, jitter,
 * punctuation pacing, emphasis), and parses inline markup.
 */

export const RE_EMPHASIS = /\*([^*]+)\*/g;
export const RE_PAUSE = /\[pause\s+(\d+)\]/gi;
export const RE_PITCH = /\[pitch\s+([+-]?\d*(?:\.\d+)?)\]/gi;
export const RE_RATE = /\[rate\s+([+-]?\d*(?:\.\d+)?)\]/gi;
export const RE_VOICE = /\[voice\s+([^\]]+)\]/gi;

export class ProsodyEngine {
  constructor(voiceManager) {
    this.voiceManager = voiceManager;
  }

  /**
   * Main pipeline: transforms raw input text into executable utterance chunks
   * @param {string} rawText 
   * @param {Object} options 
   * @returns {Array<Object>} chunks
   */
  process(rawText, options = {}) {
    if (!rawText || !rawText.trim()) {
      return [];
    }

    const {
      defaultVoice = null,
      basePitch = 1.0,
      baseRate = 1.0,
      baseVolume = 1.0,
      pauseLength = 300,
      variationPitch = 12,
      variationRate = 10,
      emphasisStrength = 0.4,
      humanizeEnabled = true,
      humanizeIntensity = 0.8,
      curveProfile = 'neutral'
    } = options;

    const intensity = humanizeEnabled ? Math.max(0, Math.min(1, humanizeIntensity)) : 0;

    // 1. Split raw text into sentence tokens while preserving punctuation
    const sentenceTokens = this.splitIntoSentences(rawText);

    const chunks = [];
    let currentVoice = defaultVoice;
    let inlinePitchOffset = 0;
    let inlineRateOffset = 0;
    let globalChunkIdx = 0;

    sentenceTokens.forEach((sentObj, sentenceIdx) => {
      const { rawSentence, punctuation, isParagraphEnd } = sentObj;

      // 2. Tokenize sentence into phrase and markup units
      const phraseUnits = this.tokenizeSentenceUnits(rawSentence);
      const totalUnits = phraseUnits.length;

      phraseUnits.forEach((unit, unitIdx) => {
        // Handle inline commands
        if (unit.type === 'pause_cmd') {
          chunks.push({
            chunkId: globalChunkIdx++,
            sentenceIndex: sentenceIdx,
            text: `[pause ${unit.ms}ms]`,
            cleanText: '',
            displayText: `[pause ${unit.ms}ms]`,
            voice: currentVoice,
            pitch: basePitch,
            rate: baseRate,
            volume: 0,
            pauseAfterMs: unit.ms,
            isPauseOnly: true,
            isEmphasized: false,
            charRange: unit.charRange,
            prosody: { pitchDelta: 0, rateDelta: 0 }
          });
          return;
        }

        if (unit.type === 'pitch_cmd') {
          inlinePitchOffset = unit.value;
          return;
        }

        if (unit.type === 'rate_cmd') {
          inlineRateOffset = unit.value;
          return;
        }

        if (unit.type === 'voice_cmd') {
          const matchedVoice = this.voiceManager ? this.voiceManager.findVoice(unit.voiceName) : null;
          if (matchedVoice) {
            currentVoice = matchedVoice;
          }
          return;
        }

        // Standard text or emphasized text unit
        const cleanText = unit.text.trim();
        if (!cleanText) return;

        const isFirstInSentence = unitIdx === 0;
        const isLastInSentence = unitIdx === totalUnits - 1;

        // --- PROSODY ENGINEERING CALCULATIONS ---
        let pitchDelta = 0;
        let rateDelta = 0;
        let volumeDelta = 0;
        let pauseAfter = 0;

        if (intensity > 0) {
          // A. Natural Declination: pitch starts higher at sentence opening, slightly drops
          if (isFirstInSentence) {
            pitchDelta += 0.08 * intensity;
          } else if (isLastInSentence && punctuation !== '?') {
            pitchDelta -= 0.07 * intensity;
          } else {
            // Gradual decline across phrase units
            const progress = totalUnits > 1 ? unitIdx / (totalUnits - 1) : 0.5;
            pitchDelta += (0.04 - progress * 0.08) * intensity;
          }

          // B. Question rise (?)
          if (punctuation === '?' && isLastInSentence) {
            pitchDelta += 0.24 * intensity; // upward pitch contour at end of question
            rateDelta += 0.05 * intensity;
          }

          // C. Exclamation energy (!)
          if (punctuation === '!') {
            pitchDelta += 0.16 * intensity;
            rateDelta += 0.12 * intensity;
            volumeDelta += 0.1 * intensity;
          }

          // D. Ellipsis hesitation (… or ...)
          if (punctuation === '…' || punctuation === '...') {
            rateDelta -= 0.18 * intensity;
            pauseAfter += 450 * intensity;
          }

          // E. Emotion Profile Influences
          switch (curveProfile) {
            case 'warm_rise':
              pitchDelta += 0.06 * intensity;
              rateDelta += 0.04 * intensity;
              break;
            case 'dynamic_peaks':
              pitchDelta += (unitIdx % 2 === 0 ? 0.12 : -0.06) * intensity;
              rateDelta += 0.08 * intensity;
              break;
            case 'gentle_fall':
              pitchDelta -= 0.06 * intensity;
              rateDelta -= 0.08 * intensity;
              pauseAfter += 180 * intensity;
              break;
            case 'subdued_flat':
              pitchDelta -= 0.12 * intensity;
              rateDelta -= 0.12 * intensity;
              volumeDelta -= 0.1 * intensity;
              break;
            case 'sharp_attack':
              pitchDelta += 0.1 * intensity;
              rateDelta += 0.1 * intensity;
              pauseAfter = Math.max(50, pauseAfter - 100);
              break;
            case 'whisper':
              pitchDelta -= 0.08 * intensity;
              rateDelta -= 0.12 * intensity;
              volumeDelta -= 0.25 * intensity;
              pauseAfter += 150 * intensity;
              break;
            case 'story_cadence':
              pitchDelta += (isFirstInSentence ? 0.14 : -0.04) * intensity;
              pauseAfter += 200 * intensity;
              break;
            case 'robotic_quantized':
              // Completely flat zero modulation
              pitchDelta = 0;
              rateDelta = 0;
              break;
            case 'deep_chest':
              pitchDelta -= 0.14 * intensity;
              rateDelta -= 0.05 * intensity;
              pauseAfter += 220 * intensity;
              break;
          }

          // F. Jitter / Organic Variation
          if (variationPitch > 0) {
            const jitterP = (Math.sin(globalChunkIdx * 2.7) * 0.6 + (Math.random() - 0.5) * 0.8) *
              (variationPitch / 100) * 0.16 * intensity;
            pitchDelta += jitterP;
          }
          if (variationRate > 0) {
            const jitterR = (Math.cos(globalChunkIdx * 2.1) * 0.5 + (Math.random() - 0.5) * 0.7) *
              (variationRate / 100) * 0.14 * intensity;
            rateDelta += jitterR;
          }
        }

        // G. Word-level Emphasis (*word*)
        if (unit.isEmphasized) {
          const emp = Math.max(0, Math.min(1, emphasisStrength));
          pitchDelta += 0.22 * emp;
          rateDelta -= 0.16 * emp; // deliberate articulation
          volumeDelta += 0.15 * emp;
        }

        // H. Clause & Sentence Pause Length Calculation
        if (isLastInSentence) {
          pauseAfter += pauseLength * (isParagraphEnd ? 1.6 : 1.0);
        } else if (unit.phraseDelimiter === ',' || unit.phraseDelimiter === ';' || unit.phraseDelimiter === ':') {
          pauseAfter += pauseLength * 0.55;
        } else {
          pauseAfter += 60; // micro-pause between emphasized words and clauses
        }

        // Apply inline offsets from [pitch] and [rate] tags
        pitchDelta += inlinePitchOffset;
        rateDelta += inlineRateOffset;

        // Multiplicative pitch calculation: finalPitch = basePitch * (1 + pitchDelta) (Fix 6)
        const finalPitch = Math.min(2.0, Math.max(0.0, basePitch * (1 + pitchDelta)));
        const finalRate = Math.min(2.0, Math.max(0.5, baseRate + rateDelta));
        const finalVolume = Math.min(1.0, Math.max(0.0, baseVolume + volumeDelta));

        const chunkLang = this.detectLanguage(cleanText, options.speakInLang || (currentVoice ? currentVoice.lang : 'en'));

        chunks.push({
          chunkId: globalChunkIdx++,
          sentenceIndex: sentenceIdx,
          text: cleanText,
          cleanText: this.stripFormatting(cleanText),
          displayText: unit.rawText || cleanText,
          voice: currentVoice,
          lang: chunkLang,
          pitch: Number(finalPitch.toFixed(2)),
          rate: Number(finalRate.toFixed(2)),
          volume: Number(finalVolume.toFixed(2)),
          pauseAfterMs: Math.round(pauseAfter),
          isPauseOnly: false,
          isEmphasized: unit.isEmphasized,
          punctuation: isLastInSentence ? punctuation : unit.phraseDelimiter,
          charRange: unit.charRange,
          prosody: {
            pitchDelta: Number(pitchDelta.toFixed(2)),
            rateDelta: Number(rateDelta.toFixed(2))
          }
        });
      });

      // Reset inline offsets on sentence boundaries (as requested in spec)
      inlinePitchOffset = 0;
      inlineRateOffset = 0;
    });

    // Re-center spoken chunks so mean pitch equals basePitch and mean rate equals baseRate (Fix 6)
    const spokenChunks = chunks.filter(c => !c.isPauseOnly && c.cleanText.length > 0);
    if (spokenChunks.length > 0) {
      const meanPitch = spokenChunks.reduce((acc, c) => acc + c.pitch, 0) / spokenChunks.length;
      const pitchOffset = meanPitch - basePitch;
      const meanRate = spokenChunks.reduce((acc, c) => acc + c.rate, 0) / spokenChunks.length;
      const rateOffset = meanRate - baseRate;

      spokenChunks.forEach(c => {
        c.pitch = Number(Math.min(2.0, Math.max(0.0, c.pitch - pitchOffset)).toFixed(2));
        c.rate = Number(Math.min(2.0, Math.max(0.5, c.rate - rateOffset)).toFixed(2));
      });

      // Fine adjustment for rounding error so mean equals basePitch +/- 0.01
      const adjMeanPitch = spokenChunks.reduce((acc, c) => acc + c.pitch, 0) / spokenChunks.length;
      const resPitch = basePitch - adjMeanPitch;
      if (Math.abs(resPitch) >= 0.008 && Math.abs(resPitch) <= 0.04) {
        spokenChunks[0].pitch = Number(Math.min(2.0, Math.max(0.0, spokenChunks[0].pitch + resPitch)).toFixed(2));
      }

      const adjMeanRate = spokenChunks.reduce((acc, c) => acc + c.rate, 0) / spokenChunks.length;
      const resRate = baseRate - adjMeanRate;
      if (Math.abs(resRate) >= 0.008 && Math.abs(resRate) <= 0.04) {
        spokenChunks[0].rate = Number(Math.min(2.0, Math.max(0.5, spokenChunks[0].rate + resRate)).toFixed(2));
      }
    }

    return chunks;
  }

  /**
   * Detects script/language of a chunk:
   * Devanagari -> hi, Arabic -> ar, Cyrillic -> ru, CJK -> zh, Latin -> default
   */
  detectLanguage(text, defaultLang = 'en') {
    if (!text) return defaultLang;
    if (/[\u0900-\u097F]/.test(text)) return 'hi';
    if (/[\u0600-\u06FF]/.test(text)) return 'ar';
    if (/[\u0400-\u04FF]/.test(text)) return 'ru';
    if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
    return defaultLang;
  }

  /**
   * Splits raw text into sentence tokens, handling abbreviations and punctuation.
   * Supports English (. ! ? ...) and Hindi (। ॥) boundaries without breaking decimals (3.5)
   * @param {string} text 
   * @returns {Array<{ rawSentence: string, punctuation: string, isParagraphEnd: boolean }>}
   */
  splitIntoSentences(text) {
    if (!text) return [];

    let safeText = text;
    const placeholderMap = [];
    const addPlaceholder = (match) => {
      const token = `__PROTECTED_${placeholderMap.length}__`;
      placeholderMap.push({ token, match });
      return token;
    };

    // 1. Protect decimal numbers (e.g. 3.14, 0.5)
    safeText = safeText.replace(/\b\d+\.\d+\b/g, addPlaceholder);

    // 2. Protect multi-letter acronyms (e.g. D.C., U.S.A., a.m., p.m.)
    safeText = safeText.replace(/\b(?:[A-Za-z]\.){2,}/g, addPlaceholder);

    // 3. Protect common titles and abbreviations (e.g. Dr., Mr., etc.)
    safeText = safeText.replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|approx|dept|e\.g|i\.e|Gen|Col|Lt)\./gi, addPlaceholder);

    // Match sentences ending in ., !, ?, …, ..., Hindi । or ॥, or paragraph breaks (\n\n)
    const sentenceRegex = /([^.!?…।॥\n]+(?:[.!?…।॥]+|\n{2,}|$))/gu;
    const matches = safeText.match(sentenceRegex) || [safeText];

    const results = [];
    matches.forEach(segment => {
      let restored = segment;
      placeholderMap.forEach(({ token, match }) => {
        restored = restored.replace(token, match);
      });

      const trimmed = restored.trim();
      if (!trimmed) return;

      let punctuation = '.';
      if (/[?？]/.test(trimmed)) punctuation = '?';
      else if (/[!！]/.test(trimmed)) punctuation = '!';
      else if (/(…|\.{3,})/.test(trimmed)) punctuation = '…';
      else if (/[।॥]/.test(trimmed)) punctuation = '।';

      const isParagraphEnd = segment.includes('\n\n') || segment.endsWith('\n');

      results.push({
        rawSentence: trimmed,
        punctuation,
        isParagraphEnd
      });
    });

    return results;
  }

  /**
   * Tokenizes a sentence into sub-phrases and inline tags:
   * [pause 500], [pitch +0.3], [rate -0.2], [voice Name], *emphasized*
   * @param {string} sentence 
   * @returns {Array<Object>}
   */
  tokenizeSentenceUnits(sentence) {
    const units = [];

    // Regex for inline markup:
    // [pause 500], [pitch +0.2], [rate -0.1], [voice Guy], *emphasized word*
    const markupRegex = /\[pause\s+(\d+)\]|\[pitch\s+([+-]?\d*(?:\.\d+)?)\]|\[rate\s+([+-]?\d*(?:\.\d+)?)\]|\[voice\s+([^\]]+)\]|\*([^*]+)\*/gi;

    let lastIndex = 0;
    let match;

    while ((match = markupRegex.exec(sentence)) !== null) {
      const matchIndex = match.index;
      
      // Text before tag
      if (matchIndex > lastIndex) {
        const textSegment = sentence.substring(lastIndex, matchIndex);
        this._splitClauses(textSegment, units, lastIndex);
      }

      // Check which pattern matched
      if (match[1] !== undefined) {
        // [pause 500]
        units.push({
          type: 'pause_cmd',
          ms: parseInt(match[1], 10),
          charRange: [matchIndex, matchIndex + match[0].length]
        });
      } else if (match[2] !== undefined) {
        // [pitch +0.2]
        units.push({
          type: 'pitch_cmd',
          value: parseFloat(match[2]),
          charRange: [matchIndex, matchIndex + match[0].length]
        });
      } else if (match[3] !== undefined) {
        // [rate -0.1]
        units.push({
          type: 'rate_cmd',
          value: parseFloat(match[3]),
          charRange: [matchIndex, matchIndex + match[0].length]
        });
      } else if (match[4] !== undefined) {
        // [voice Name]
        units.push({
          type: 'voice_cmd',
          voiceName: match[4].trim(),
          charRange: [matchIndex, matchIndex + match[0].length]
        });
      } else if (match[5] !== undefined) {
        // *emphasized*
        units.push({
          type: 'text',
          text: match[5],
          rawText: match[0],
          isEmphasized: true,
          phraseDelimiter: '',
          charRange: [matchIndex, matchIndex + match[0].length]
        });
      }

      lastIndex = markupRegex.lastIndex;
    }

    // Trailing text after last match
    if (lastIndex < sentence.length) {
      const textSegment = sentence.substring(lastIndex);
      this._splitClauses(textSegment, units, lastIndex);
    }

    return units;
  }

  /**
   * Splits a plain text segment into sub-clauses around commas, colons, semicolons
   */
  _splitClauses(text, units, baseOffset) {
    if (!text.trim()) return;

    // Split on commas, colons, semicolons while capturing delimiters
    const clauseRegex = /([^,;:，；：]+)([,;:，；：]?)/g;
    let match;

    while ((match = clauseRegex.exec(text)) !== null) {
      const phrase = match[1].trim();
      const delimiter = match[2] || '';
      const start = baseOffset + match.index;
      const end = start + match[0].length;

      if (phrase) {
        units.push({
          type: 'text',
          text: phrase + delimiter,
          rawText: phrase + delimiter,
          isEmphasized: false,
          phraseDelimiter: delimiter,
          charRange: [start, end]
        });
      }
    }
  }

  /**
   * Clean markup characters from text
   * @param {string} text 
   * @returns {string}
   */
  stripFormatting(text) {
    return text
      .replace(/\[pause\s+\d+\]/gi, '')
      .replace(/\[pitch\s+[+-]?\d*(?:\.\d+)?\]/gi, '')
      .replace(/\[rate\s+[+-]?\d*(?:\.\d+)?\]/gi, '')
      .replace(/\[voice\s+[^\]]+\]/gi, '')
      .replace(/\*([^*]+)\*/g, '$1')
      .trim();
  }

  /**
   * Estimates duration of speech in seconds
   * @param {Array<Object>} chunks 
   * @returns {number} duration in seconds
   */
  estimateDuration(chunks) {
    if (!chunks || chunks.length === 0) return 0;

    let totalSeconds = 0;
    chunks.forEach(chunk => {
      if (chunk.isPauseOnly) {
        totalSeconds += chunk.pauseAfterMs / 1000;
        return;
      }

      const wordCount = chunk.cleanText.split(/\s+/).filter(Boolean).length;
      // Normal speaking rate is ~150 words per minute -> 2.5 words/sec at rate 1.0
      const wordsPerSec = 2.5 * (chunk.rate || 1.0);
      const speechSeconds = wordCount / Math.max(0.5, wordsPerSec);

      totalSeconds += speechSeconds + (chunk.pauseAfterMs / 1000);
    });

    return Math.max(1, Math.round(totalSeconds));
  }
}
