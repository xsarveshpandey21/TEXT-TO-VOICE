/**
 * HumanVoice Studio - Voice Matcher Module (Browser Audio DSP)
 * Pure JavaScript acoustic biometric profiling using the Web Audio API.
 * Features:
 *  - 16 kHz Mono resampling & optimal window selection
 *  - 40ms/10ms energy & RMS dB calculation
 *  - YIN F0 algorithm (60-500 Hz) with 5-frame median filtering
 *  - Inline Cooley-Tukey Radix-2 FFT for spectral flatness & music detection
 *  - Syllable nuclei extraction (300-3000 Hz BiquadFilter envelope) & speaking rate
 *  - Inter-phrase pause detection (runs >= 150ms)
 *  - Quality scoring & warning heuristics
 */

export class VoiceMatcher {
  constructor() {
    this.sampleRate = 16000;
    this.frameDuration = 0.040; // 40 ms
    this.hopDuration = 0.010;   // 10 ms
    this.frameSize = Math.round(this.sampleRate * this.frameDuration); // 640
    this.hopSize = Math.round(this.sampleRate * this.hopDuration);     // 160
  }

  /**
   * Main analysis pipeline
   * @param {File|Blob|ArrayBuffer} fileOrBlob 
   * @param {Function} onProgress (percent: number, message: string) => void
   * @returns {Promise<Object>} profile
   */
  async analyze(fileOrBlob, onProgress = null) {
    const notify = (pct, msg) => {
      if (typeof onProgress === 'function') {
        onProgress(Math.round(pct), msg || `Analyzing… ${Math.round(pct)}%`);
      }
    };

    notify(5, 'Reading audio data…');
    let arrayBuffer;
    if (fileOrBlob instanceof ArrayBuffer) {
      arrayBuffer = fileOrBlob;
    } else if (fileOrBlob && typeof fileOrBlob.arrayBuffer === 'function') {
      arrayBuffer = await fileOrBlob.arrayBuffer();
    } else {
      throw new Error('Invalid audio input provided.');
    }

    notify(10, 'Decoding audio…');
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    let decodedBuffer;
    try {
      decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      if (audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
    }

    notify(20, 'Resampling to 16 kHz mono…');
    const pcmData = await this._resampleAndMixDown(decodedBuffer);

    // Initial check for clipping
    let clipCount = 0;
    for (let i = 0; i < pcmData.length; i++) {
      if (Math.abs(pcmData[i]) >= 0.99) clipCount++;
    }
    const clippingRatio = pcmData.length > 0 ? clipCount / pcmData.length : 0;

    notify(25, 'Segmenting audio frames…');
    // Pre-calculate RMS and voiced frames
    const rawFrames = this._extractFrames(pcmData);
    if (rawFrames.length === 0) {
      throw new Error('Audio clip is too short or empty.');
    }

    // Determine max dB
    let maxDb = -120;
    const frameEnergies = new Float32Array(rawFrames.length);
    for (let i = 0; i < rawFrames.length; i++) {
      const db = this._computeRMSDb(rawFrames[i]);
      frameEnergies[i] = db;
      if (db > maxDb) maxDb = db;
    }

    const voicedThreshold = maxDb - 35;
    const isVoicedFrame = new Uint8Array(rawFrames.length);
    let voicedFramesCount = 0;
    for (let i = 0; i < rawFrames.length; i++) {
      if (frameEnergies[i] > voicedThreshold) {
        isVoicedFrame[i] = 1;
        voicedFramesCount++;
      }
    }

    const totalDurationSec = pcmData.length / this.sampleRate;
    const voicedDurationSec = (voicedFramesCount * this.hopSize) / this.sampleRate;

    if (voicedDurationSec < 3.0) {
      throw new Error(`Clip contains only ${voicedDurationSec.toFixed(1)}s of voiced speech. Minimum 3.0s required.`);
    }

    // If clip > 30s, choose best 15s window (highest number of voiced frames)
    let selectedPCM = pcmData;
    let selectedFrames = rawFrames;
    let selectedEnergies = frameEnergies;
    let selectedVoiced = isVoicedFrame;

    if (totalDurationSec > 30.0) {
      notify(30, 'Selecting optimal 15-second speech window…');
      const windowFramesCount = Math.round(15.0 / this.hopDuration);
      let bestStartIndex = 0;
      let maxVoicedInWindow = 0;

      // Sliding window sum of voiced frames
      let currentVoiced = 0;
      for (let i = 0; i < windowFramesCount && i < rawFrames.length; i++) {
        currentVoiced += isVoicedFrame[i];
      }
      maxVoicedInWindow = currentVoiced;

      for (let i = 1; i <= rawFrames.length - windowFramesCount; i++) {
        currentVoiced = currentVoiced - isVoicedFrame[i - 1] + isVoicedFrame[i + windowFramesCount - 1];
        if (currentVoiced > maxVoicedInWindow) {
          maxVoicedInWindow = currentVoiced;
          bestStartIndex = i;
        }
      }

      const pcmStart = bestStartIndex * this.hopSize;
      const pcmEnd = Math.min(pcmData.length, pcmStart + 15 * this.sampleRate);
      selectedPCM = pcmData.slice(pcmStart, pcmEnd);
      selectedFrames = rawFrames.slice(bestStartIndex, bestStartIndex + windowFramesCount);
      selectedEnergies = frameEnergies.slice(bestStartIndex, bestStartIndex + windowFramesCount);
      selectedVoiced = isVoicedFrame.slice(bestStartIndex, bestStartIndex + windowFramesCount);
    }

    notify(35, 'Analyzing fundamental pitch (YIN F0)…');
    const f0Values = [];
    const spectralFlatnessValues = [];
    const validVoicedEnergies = [];

    const numFrames = selectedFrames.length;
    const batchSize = 60; // yield to UI every 60 frames (~600ms audio)

    for (let i = 0; i < numFrames; i++) {
      if (i % batchSize === 0) {
        const pct = 35 + ((i / numFrames) * 35);
        notify(pct, `Analyzing pitch & spectral energy… ${Math.round(pct)}%`);
        await new Promise(r => setTimeout(r, 0));
      }

      if (selectedVoiced[i]) {
        validVoicedEnergies.push(selectedEnergies[i]);

        // YIN F0 Estimation
        const f0Result = this._computeYIN(selectedFrames[i]);
        if (f0Result.confidence > 0.80 && f0Result.f0 >= 60 && f0Result.f0 <= 500) {
          f0Values.push({ frameIndex: i, f0: f0Result.f0 });
        }

        // Spectral Flatness for Music/Noise Detection
        const flatness = this._computeSpectralFlatness(selectedFrames[i]);
        spectralFlatnessValues.push(flatness);
      }
    }

    notify(75, 'Filtering pitch contours & guarding octave jumps…');
    // Apply 5-frame median filter on valid F0s
    const smoothedF0 = this._applyMedianFilter(f0Values.map(v => v.f0), 5);

    if (smoothedF0.length < 10) {
      throw new Error('Could not reliably detect a clear speaking pitch. Please use a clearer vocal recording.');
    }

    // Octave-error guard: fold any F0 > 1.8x or < 0.55x the tentative track median
    const tentativeSorted = [...smoothedF0].sort((a, b) => a - b);
    const tentativeMedian = this._percentile(tentativeSorted, 0.50);
    const foldedF0 = [];
    for (let i = 0; i < smoothedF0.length; i++) {
      let val = smoothedF0[i];
      if (val > 1.8 * tentativeMedian) {
        val *= 0.5;
      } else if (val < 0.55 * tentativeMedian) {
        val *= 2.0;
      }
      foldedF0.push(val);
    }

    // Recompute pitch statistics after octave folding
    foldedF0.sort((a, b) => a - b);
    const f0Median = this._percentile(foldedF0, 0.50);
    const f0P10 = this._percentile(foldedF0, 0.10);
    const f0P90 = this._percentile(foldedF0, 0.90);

    // Semitone standard deviation = std(12 * log2(f0 / median))
    let semitoneSqSum = 0;
    for (let i = 0; i < foldedF0.length; i++) {
      const st = 12 * Math.log2(foldedF0[i] / f0Median);
      semitoneSqSum += st * st;
    }
    const f0StdSemitones = Math.sqrt(semitoneSqSum / foldedF0.length);

    // Voice Type safe-zone classification with confidence & reason (Fix 2)
    const classification = this._classifyVoiceType(f0Median, f0P10);

    notify(80, 'Measuring pause patterns…');
    const { pauseMeanMs, pauseP90Ms, pausesPerMin, pausesMs } = this._analyzePauses(
      selectedVoiced,
      this.hopDuration
    );

    notify(85, 'Analyzing syllable rhythm & pacing…');
    const { syllablesPerSec, rateVariability } = await this._analyzeSyllableRhythm(
      selectedPCM,
      selectedVoiced,
      pausesMs
    );

    // Loudness expressiveness (standard deviation of voiced frame dB)
    let energyMean = 0;
    for (let i = 0; i < validVoicedEnergies.length; i++) energyMean += validVoicedEnergies[i];
    energyMean /= validVoicedEnergies.length;

    let energySqSum = 0;
    for (let i = 0; i < validVoicedEnergies.length; i++) {
      const diff = validVoicedEnergies[i] - energyMean;
      energySqSum += diff * diff;
    }
    const loudnessStdDb = Math.sqrt(energySqSum / validVoicedEnergies.length);

    // Mean spectral flatness
    let meanFlatness = 0;
    if (spectralFlatnessValues.length > 0) {
      let sumFlat = 0;
      for (let i = 0; i < spectralFlatnessValues.length; i++) sumFlat += spectralFlatnessValues[i];
      meanFlatness = sumFlat / spectralFlatnessValues.length;
    }

    // Noise floor & SNR estimate
    let noiseDbSum = 0;
    let noiseFramesCount = 0;
    for (let i = 0; i < selectedFrames.length; i++) {
      if (!selectedVoiced[i]) {
        noiseDbSum += selectedEnergies[i];
        noiseFramesCount++;
      }
    }
    const noiseFloorDb = noiseFramesCount > 0 ? noiseDbSum / noiseFramesCount : maxDb - 50;
    const snrDb = Math.max(0, energyMean - noiseFloorDb);

    // Quality Score (0-100) & Warning Heuristics
    const warnings = [];
    let qualityScore = 100;

    if (voicedDurationSec < 5.0) {
      qualityScore -= 15;
      warnings.push(`Short speech duration (${voicedDurationSec.toFixed(1)}s voiced). For best matching, use a 6–15s clip.`);
    }

    if (clippingRatio > 0.01) {
      qualityScore -= 20;
      warnings.push(`Audio clipping detected (${(clippingRatio * 100).toFixed(1)}%). Lower recording volume to prevent distortion.`);
    }

    if (meanFlatness > 0.30) {
      qualityScore -= 25;
      warnings.push('Background music or broad-band noise detected — use a clean speech-only clip for accurate pitch matching.');
    }

    if (snrDb < 15) {
      qualityScore -= 20;
      warnings.push(`Low signal-to-noise ratio (~${Math.round(snrDb)} dB). Record in a quiet room closer to the microphone.`);
    }

    qualityScore = Math.max(20, Math.min(100, Math.round(qualityScore)));

    notify(100, 'Analysis complete!');

    return {
      f0_median_hz: Math.round(f0Median),
      f0_p10: Math.round(f0P10),
      f0_p90: Math.round(f0P90),
      f0_std_semitones: Number(f0StdSemitones.toFixed(2)),
      voice_type: classification.voice_type,
      voice_type_confidence: classification.voice_type_confidence,
      voice_type_reason: classification.voice_type_reason,
      syllables_per_sec: Number(syllablesPerSec.toFixed(2)),
      rate_variability: Number(rateVariability.toFixed(2)),
      pause_mean_ms: Math.round(pauseMeanMs),
      pause_p90_ms: Math.round(pauseP90Ms),
      pauses_per_min: Math.round(pausesPerMin),
      loudness_std_db: Number(loudnessStdDb.toFixed(2)),
      mean_flatness: Number(meanFlatness.toFixed(3)),
      quality_score: qualityScore,
      warnings: warnings,
      duration_s: Number(totalDurationSec.toFixed(2)),
      voiced_duration_s: Number(voicedDurationSec.toFixed(2)),
      voiced_ratio: Number((voicedDurationSec / totalDurationSec).toFixed(2))
    };
  }

  /**
   * Safe-zone voice classification based on median F0 and p10 floor (Fix 2)
   */
  _classifyVoiceType(f0Median, f0P10) {
    if (f0Median > 290 && f0P10 > 220) {
      const dist = Math.min(f0Median - 290, f0P10 - 220);
      const conf = Math.min(1.0, 0.70 + (dist / 80) * 0.30);
      return {
        voice_type: 'child_like',
        voice_type_confidence: Number(conf.toFixed(2)),
        voice_type_reason: `High pitch contour (median ${Math.round(f0Median)} Hz, p10 ${Math.round(f0P10)} Hz)`
      };
    }

    const isMale = f0Median < 150 || (f0Median <= 175.5 && f0P10 < 120);
    const isFemale = f0Median > 185 || (f0Median >= 165 && f0P10 >= 140);

    if (isMale && !isFemale) {
      let conf = 0.85;
      if (f0Median < 150) {
        conf = Math.min(1.0, 0.75 + Math.max(0, (150 - f0Median) / 50) * 0.25);
      } else {
        conf = Math.min(1.0, 0.70 + Math.max(0, (120 - f0P10) / 40) * 0.30);
      }
      return {
        voice_type: 'male',
        voice_type_confidence: Number(conf.toFixed(2)),
        voice_type_reason: f0Median < 150
          ? `Pitch median ${Math.round(f0Median)} Hz < 150 Hz`
          : `Excited pitch ${Math.round(f0Median)} Hz with deep p10 floor ${Math.round(f0P10)} Hz < 120 Hz`
      };
    }

    if (isFemale && !isMale) {
      let conf = 0.85;
      if (f0Median > 185) {
        conf = Math.min(1.0, 0.75 + Math.max(0, (f0Median - 185) / 50) * 0.25);
      } else {
        conf = Math.min(1.0, 0.70 + Math.max(0, (f0P10 - 140) / 40) * 0.30);
      }
      return {
        voice_type: 'female',
        voice_type_confidence: Number(conf.toFixed(2)),
        voice_type_reason: f0Median > 185
          ? `Pitch median ${Math.round(f0Median)} Hz > 185 Hz`
          : `Female pitch median ${Math.round(f0Median)} Hz with p10 floor ${Math.round(f0P10)} Hz >= 140 Hz`
      };
    }

    return {
      voice_type: 'uncertain',
      voice_type_confidence: 0.40,
      voice_type_reason: `Safe-zone boundary overlap (median ${Math.round(f0Median)} Hz, p10 ${Math.round(f0P10)} Hz)`
    };
  }

  /**
   * Resamples AudioBuffer to 16 kHz Mono Float32Array using OfflineAudioContext
   */
  async _resampleAndMixDown(audioBuffer) {
    const targetLength = Math.ceil(audioBuffer.duration * this.sampleRate);
    const offlineCtx = new OfflineAudioContext(1, targetLength, this.sampleRate);

    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;

    if (audioBuffer.numberOfChannels > 1) {
      const merger = offlineCtx.createChannelMerger(1);
      source.connect(merger);
      merger.connect(offlineCtx.destination);
    } else {
      source.connect(offlineCtx.destination);
    }

    source.start(0);
    const renderedBuffer = await offlineCtx.startRendering();
    return renderedBuffer.getChannelData(0);
  }

  _extractFrames(pcm) {
    const frames = [];
    for (let start = 0; start + this.frameSize <= pcm.length; start += this.hopSize) {
      frames.push(pcm.subarray(start, start + this.frameSize));
    }
    return frames;
  }

  _computeRMSDb(frame) {
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) {
      sumSq += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sumSq / frame.length);
    return 20 * Math.log10(rms + 1e-7);
  }

  /**
   * YIN Algorithm for Fundamental Frequency (F0) Estimation
   * Validated for speech range 60 Hz to 500 Hz.
   */
  _computeYIN(frame) {
    const W = Math.floor(frame.length / 2); // 320 samples window
    const tauMin = Math.floor(this.sampleRate / 500); // 32
    const tauMax = Math.min(W - 1, Math.floor(this.sampleRate / 60)); // 266

    // 1. Difference function d(tau)
    const d = new Float32Array(tauMax + 1);
    for (let tau = 0; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const delta = frame[j] - frame[j + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }

    // 2. Cumulative mean normalized difference d'(tau)
    const dPrime = new Float32Array(tauMax + 1);
    dPrime[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      runningSum += d[tau];
      dPrime[tau] = runningSum > 0 ? (d[tau] * tau) / runningSum : 1;
    }

    // 3. Absolute threshold search (threshold = 0.15)
    const threshold = 0.15;
    let bestTau = -1;

    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (dPrime[tau] < threshold) {
        while (tau + 1 <= tauMax && dPrime[tau + 1] < dPrime[tau]) {
          tau++;
        }
        bestTau = tau;
        break;
      }
    }

    // Fallback: global minimum within tauMin..tauMax
    if (bestTau === -1) {
      let minVal = Infinity;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (dPrime[tau] < minVal) {
          minVal = dPrime[tau];
          bestTau = tau;
        }
      }
    }

    if (bestTau < tauMin || bestTau > tauMax) {
      return { f0: 0, confidence: 0 };
    }

    // 4. Parabolic interpolation
    let refinedTau = bestTau;
    if (bestTau > 0 && bestTau < tauMax) {
      const alpha = dPrime[bestTau - 1];
      const beta = dPrime[bestTau];
      const gamma = dPrime[bestTau + 1];
      const denom = 2 * (alpha - 2 * beta + gamma);
      if (Math.abs(denom) > 1e-6) {
        refinedTau = bestTau + (alpha - gamma) / denom;
      }
    }

    const confidence = Math.max(0, 1.0 - dPrime[bestTau]);
    const f0 = this.sampleRate / refinedTau;

    return { f0, confidence };
  }

  _applyMedianFilter(array, windowSize = 5) {
    if (!array || array.length === 0) return [];
    const half = Math.floor(windowSize / 2);
    const result = new Float32Array(array.length);

    for (let i = 0; i < array.length; i++) {
      const window = [];
      for (let j = -half; j <= half; j++) {
        const idx = i + j;
        if (idx >= 0 && idx < array.length) {
          window.push(array[idx]);
        }
      }
      window.sort((a, b) => a - b);
      result[i] = window[Math.floor(window.length / 2)];
    }
    return Array.from(result);
  }

  _percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    const index = p * (sortedArr.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
  }

  /**
   * Inline Cooley-Tukey Radix-2 FFT to calculate Spectral Flatness
   */
  _computeSpectralFlatness(frame) {
    const N = 512; // Power of two FFT size
    const real = new Float32Array(N);
    const imag = new Float32Array(N);

    // Apply Hann window and copy to real buffer
    const copyLen = Math.min(frame.length, N);
    for (let i = 0; i < copyLen; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (copyLen - 1)));
      real[i] = frame[i] * w;
    }

    // Radix-2 Bit Reversal
    let j = 0;
    for (let i = 0; i < N - 1; i++) {
      if (i < j) {
        const tempR = real[i]; real[i] = real[j]; real[j] = tempR;
        const tempI = imag[i]; imag[i] = imag[j]; imag[j] = tempI;
      }
      let k = N >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    // FFT Butterfly Computations
    for (let len = 2; len <= N; len <<= 1) {
      const halfLen = len >> 1;
      const angle = (-2 * Math.PI) / len;
      const wStepR = Math.cos(angle);
      const wStepI = Math.sin(angle);

      for (let i = 0; i < N; i += len) {
        let wR = 1;
        let wI = 0;
        for (let k = 0; k < halfLen; k++) {
          const pos1 = i + k;
          const pos2 = pos1 + halfLen;
          const uR = real[pos1];
          const uI = imag[pos1];
          const vR = real[pos2] * wR - imag[pos2] * wI;
          const vI = real[pos2] * wI + imag[pos2] * wR;

          real[pos1] = uR + vR;
          imag[pos1] = uI + vI;
          real[pos2] = uR - vR;
          imag[pos2] = uI - vI;

          const nextWR = wR * wStepR - wI * wStepI;
          const nextWI = wR * wStepI + wI * wStepR;
          wR = nextWR;
          wI = nextWI;
        }
      }
    }

    // Power spectrum over positive frequencies (k = 1 to N/2)
    const halfN = N >> 1;
    let logSum = 0;
    let arithSum = 0;
    let count = 0;

    for (let k = 2; k < halfN; k++) {
      const power = real[k] * real[k] + imag[k] * imag[k] + 1e-12;
      logSum += Math.log(power);
      arithSum += power;
      count++;
    }

    if (count === 0 || arithSum <= 0) return 0;
    const geomMean = Math.exp(logSum / count);
    const arithMean = arithSum / count;
    return Math.min(1.0, geomMean / arithMean);
  }

  /**
   * Syllable Nuclei Extraction via Band-Pass (300-3000 Hz) Energy Envelope
   * Fix 5: divides syllable peaks by true speaking time (net of pauses >= 150ms)
   * with 30ms moving average smoothing and 3 dB peak prominence.
   */
  async _analyzeSyllableRhythm(pcm, voicedMask, pausesMs = []) {
    if (!pcm || pcm.length === 0) {
      return { syllablesPerSec: 4.0, rateVariability: 0.15 };
    }

    // Filter audio with 300-3000 Hz bandpass using OfflineAudioContext
    const offlineCtx = new OfflineAudioContext(1, pcm.length, this.sampleRate);
    const buffer = offlineCtx.createBuffer(1, pcm.length, this.sampleRate);
    buffer.getChannelData(0).set(pcm);

    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;

    // Highpass 300 Hz
    const hp = offlineCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;

    // Lowpass 3000 Hz
    const lp = offlineCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;

    source.connect(hp);
    hp.connect(lp);
    lp.connect(offlineCtx.destination);

    source.start(0);
    const renderedBuffer = await offlineCtx.startRendering();
    const filtered = renderedBuffer.getChannelData(0);

    // Compute raw energy envelope (50 ms window, 10 ms hop)
    const envHop = Math.round(this.sampleRate * 0.010); // 160
    const envWin = Math.round(this.sampleRate * 0.050); // 800
    const rawEnv = [];
    const envTimes = [];

    for (let i = 0; i + envWin <= filtered.length; i += envHop) {
      let sumSq = 0;
      for (let j = 0; j < envWin; j++) {
        sumSq += filtered[i + j] * filtered[i + j];
      }
      const db = 20 * Math.log10(Math.sqrt(sumSq / envWin) + 1e-6);
      rawEnv.push(db);
      envTimes.push(i / this.sampleRate);
    }

    // Smooth envelope with a 30 ms moving average (3 points at 10 ms hop)
    const envPoints = new Float32Array(rawEnv.length);
    const maHalf = 1;
    for (let i = 0; i < rawEnv.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = -maHalf; j <= maHalf; j++) {
        const idx = i + j;
        if (idx >= 0 && idx < rawEnv.length) {
          sum += rawEnv[idx];
          count++;
        }
      }
      envPoints[i] = sum / count;
    }

    // Peak picking: minimum 3 dB prominence and 100 ms separation (Fix 5)
    const minSeparationSec = 0.100;
    const minProminenceDb = 3.0;
    const syllablePeaks = [];

    for (let i = 1; i < envPoints.length - 1; i++) {
      if (envPoints[i] > envPoints[i - 1] && envPoints[i] > envPoints[i + 1]) {
        // Measure local trough depth within +/- 10 frames
        let leftTrough = envPoints[i];
        for (let l = i - 1; l >= Math.max(0, i - 10); l--) {
          if (envPoints[l] < leftTrough) leftTrough = envPoints[l];
        }
        let rightTrough = envPoints[i];
        for (let r = i + 1; r < Math.min(envPoints.length, i + 10); r++) {
          if (envPoints[r] < rightTrough) rightTrough = envPoints[r];
        }

        const prominence = envPoints[i] - Math.max(leftTrough, rightTrough);
        if (prominence >= minProminenceDb) {
          const t = envTimes[i];
          if (syllablePeaks.length === 0 || (t - syllablePeaks[syllablePeaks.length - 1].time) >= minSeparationSec) {
            syllablePeaks.push({ time: t, db: envPoints[i] });
          }
        }
      }
    }

    // Speaking time = (last voiced frame - first voiced frame) - sum(pauses >= 150 ms) (Fix 5)
    let firstVoiced = -1;
    let lastVoiced = -1;
    if (voicedMask && voicedMask.length > 0) {
      for (let i = 0; i < voicedMask.length; i++) {
        if (voicedMask[i]) {
          if (firstVoiced === -1) firstVoiced = i;
          lastVoiced = i;
        }
      }
    }

    let speakingTimeSec = 0;
    if (firstVoiced !== -1 && lastVoiced >= firstVoiced) {
      const voicedSpanSec = (lastVoiced - firstVoiced + 1) * this.hopDuration;
      const pauseSumSec = (pausesMs || []).reduce((acc, ms) => acc + (ms / 1000), 0);
      speakingTimeSec = Math.max(1.0, voicedSpanSec - pauseSumSec);
    } else {
      speakingTimeSec = Math.max(1.0, pcm.length / this.sampleRate);
    }

    let syllablesPerSec = syllablePeaks.length / speakingTimeSec;
    syllablesPerSec = Math.max(2.0, Math.min(8.0, syllablesPerSec));

    // Rate variability in 2-second rolling windows
    const windowSec = 2.0;
    const hopSec = 0.5;
    const totalSec = pcm.length / this.sampleRate;
    const windowRates = [];

    for (let t = 0; t + windowSec <= totalSec; t += hopSec) {
      let count = 0;
      for (let p = 0; p < syllablePeaks.length; p++) {
        if (syllablePeaks[p].time >= t && syllablePeaks[p].time < t + windowSec) {
          count++;
        }
      }
      windowRates.push(count / windowSec);
    }

    let rateVariability = 0.15;
    if (windowRates.length > 2) {
      let mean = 0;
      for (let i = 0; i < windowRates.length; i++) mean += windowRates[i];
      mean /= windowRates.length;

      if (mean > 0) {
        let sqSum = 0;
        for (let i = 0; i < windowRates.length; i++) {
          const d = windowRates[i] - mean;
          sqSum += d * d;
        }
        const std = Math.sqrt(sqSum / windowRates.length);
        rateVariability = Math.max(0.05, Math.min(0.50, std / mean));
      }
    }

    return { syllablesPerSec, rateVariability };
  }

  /**
   * Measures pauses >= 150ms between voiced speech segments
   */
  _analyzePauses(voicedMask, hopDurationSec) {
    const minPauseFrames = Math.round(0.150 / hopDurationSec); // 15 frames
    const pausesMs = [];

    // Find first and last voiced frame to ignore leading and trailing silence
    let firstVoiced = -1;
    let lastVoiced = -1;
    for (let i = 0; i < voicedMask.length; i++) {
      if (voicedMask[i]) {
        if (firstVoiced === -1) firstVoiced = i;
        lastVoiced = i;
      }
    }

    if (firstVoiced !== -1 && lastVoiced > firstVoiced) {
      let unvoicedRun = 0;
      for (let i = firstVoiced; i <= lastVoiced; i++) {
        if (!voicedMask[i]) {
          unvoicedRun++;
        } else {
          if (unvoicedRun >= minPauseFrames) {
            pausesMs.push(unvoicedRun * hopDurationSec * 1000);
          }
          unvoicedRun = 0;
        }
      }
    }

    if (pausesMs.length === 0) {
      return { pauseMeanMs: 250, pauseP90Ms: 350, pausesPerMin: 12, pausesMs: [] };
    }

    pausesMs.sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < pausesMs.length; i++) sum += pausesMs[i];
    const pauseMeanMs = sum / pausesMs.length;
    const pauseP90Ms = this._percentile(pausesMs, 0.90);

    const speechMinutes = (voicedMask.length * hopDurationSec) / 60;
    const pausesPerMin = speechMinutes > 0 ? pausesMs.length / speechMinutes : 15;

    return { pauseMeanMs, pauseP90Ms, pausesPerMin, pausesMs };
  }
}
