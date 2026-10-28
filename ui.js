/**
 * HumanVoice Studio - UI Controller Module
 * Handles DOM interactions, sliders, live Prosody Graph canvas,
 * animated speaking waveform visualizer, and tab audio recording.
 */

export class UIController {
  constructor() {
    this.prosodyCanvas = null;
    this.prosodyCtx = null;
    this.waveformCanvas = null;
    this.waveformCtx = null;
    this.waveformAnimId = null;
    this.isSpeaking = false;
    this.boundaryEnergy = 0.2;
    this.currentChunkIndex = -1;
    this.currentChunks = [];

    // Recorder state
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordingStream = null;
    this.isRecording = false;

    // Real Audio Analyser for Cloned Voice Engine
    this.realAudioAnalyser = null;
    this.frequencyDataArray = null;
  }

  setRealAudioAnalyser(analyser) {
    this.realAudioAnalyser = analyser;
    if (analyser) {
      this.frequencyDataArray = new Uint8Array(analyser.frequencyBinCount);
    } else {
      this.frequencyDataArray = null;
    }
  }

  initVisualizers() {
    this.prosodyCanvas = document.getElementById('prosodyCanvas');
    if (this.prosodyCanvas) {
      this.prosodyCtx = this.prosodyCanvas.getContext('2d');
      this.resizeCanvas(this.prosodyCanvas);
      window.addEventListener('resize', () => {
        this.resizeCanvas(this.prosodyCanvas);
        this.renderProsodyGraph(this.currentChunks, this.currentChunkIndex);
      });
    }

    this.waveformCanvas = document.getElementById('waveformCanvas');
    if (this.waveformCanvas) {
      this.waveformCtx = this.waveformCanvas.getContext('2d');
      this.resizeCanvas(this.waveformCanvas);
      window.addEventListener('resize', () => {
        this.resizeCanvas(this.waveformCanvas);
      });
      this.startWaveformLoop();
    }
  }

  resizeCanvas(canvas) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(100, Math.floor(rect.width * dpr));
    canvas.height = Math.max(40, Math.floor(rect.height * dpr));
  }

  // --- PROSODY GRAPH CANVAS ---
  /**
   * Draws a graph of planned pitch and rate curves across chunks
   * @param {Array<Object>} chunks 
   * @param {number} activeChunkIdx 
   */
  renderProsodyGraph(chunks = [], activeChunkIdx = -1) {
    this.currentChunks = chunks;
    this.currentChunkIndex = activeChunkIdx;

    if (!this.prosodyCanvas || !this.prosodyCtx) return;
    const ctx = this.prosodyCtx;
    const width = this.prosodyCanvas.width;
    const height = this.prosodyCanvas.height;

    ctx.clearRect(0, 0, width, height);

    // Background grid
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.fillRect(0, 0, width, height);

    if (!chunks || chunks.length === 0) {
      ctx.fillStyle = 'rgba(150, 160, 180, 0.4)';
      ctx.font = `${Math.round(height * 0.22)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Live Prosody Curve (Enter text to view pitch & speed modulation)', width / 2, height / 2);
      return;
    }

    const padX = width * 0.05;
    const padY = height * 0.15;
    const graphW = width - padX * 2;
    const graphH = height - padY * 2;

    // Baseline center horizontal line (Pitch 1.0)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padX, height / 2);
    ctx.lineTo(width - padX, height / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const numPoints = chunks.length;
    const stepX = numPoints > 1 ? graphW / (numPoints - 1) : graphW / 2;

    // Coordinates generator
    const getPitchY = (pitch) => {
      // pitch range 0.4 to 1.8 mapped to height
      const normalized = (pitch - 0.5) / 1.3;
      return height - padY - Math.max(0, Math.min(1, normalized)) * graphH;
    };

    const getRateY = (rate) => {
      // rate range 0.5 to 1.8 mapped to height
      const normalized = (rate - 0.5) / 1.3;
      return height - padY - Math.max(0, Math.min(1, normalized)) * graphH;
    };

    // 1. Draw Rate Curve (Amber / Orange)
    ctx.beginPath();
    chunks.forEach((chunk, idx) => {
      const x = padX + idx * stepX;
      const y = getRateY(chunk.rate);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.75)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 2. Draw Pitch Curve (Cyan / Blue)
    ctx.beginPath();
    chunks.forEach((chunk, idx) => {
      const x = padX + idx * stepX;
      const y = getPitchY(chunk.pitch);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 3. Draw Nodes and Active Highlight
    chunks.forEach((chunk, idx) => {
      const x = padX + idx * stepX;
      const py = getPitchY(chunk.pitch);
      const ry = getRateY(chunk.rate);
      const isActive = idx === activeChunkIdx;

      if (isActive) {
        // Vertical active chunk cursor
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, padY);
        ctx.lineTo(x, height - padY);
        ctx.stroke();

        // Glowing halo on active pitch node
        ctx.fillStyle = 'rgba(56, 189, 248, 0.3)';
        ctx.beginPath();
        ctx.arc(x, py, 12, 0, Math.PI * 2);
        ctx.fill();
      }

      // Pitch node
      ctx.fillStyle = isActive ? '#38bdf8' : 'rgba(56, 189, 248, 0.6)';
      ctx.beginPath();
      ctx.arc(x, py, isActive ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Rate node
      ctx.fillStyle = isActive ? '#fbbf24' : 'rgba(245, 158, 11, 0.5)';
      ctx.beginPath();
      ctx.arc(x, ry, isActive ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // Legend
    ctx.font = `${Math.max(10, Math.round(height * 0.16))}px sans-serif`;
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'left';
    ctx.fillText('● Pitch Contour', padX, padY * 0.85);

    ctx.fillStyle = '#f59e0b';
    ctx.fillText('● Speech Rate', padX + 110, padY * 0.85);
  }

  // --- ANIMATED WAVEFORM VISUALIZER ---
  startWaveformLoop() {
    const render = () => {
      if (this.waveformCanvas && this.waveformCtx) {
        this.drawWaveform();
      }
      this.waveformAnimId = requestAnimationFrame(render);
    };
    this.waveformAnimId = requestAnimationFrame(render);
  }

  pulseBoundary() {
    this.boundaryEnergy = 1.0;
  }

  drawWaveform() {
    const ctx = this.waveformCtx;
    const width = this.waveformCanvas.width;
    const height = this.waveformCanvas.height;

    ctx.clearRect(0, 0, width, height);

    // Natural decay of boundary impulse
    this.boundaryEnergy = Math.max(0.15, this.boundaryEnergy * 0.94);

    const centerY = height / 2;
    const barsCount = 38;
    const barWidth = Math.max(2, (width / barsCount) * 0.65);
    const gap = (width - barsCount * barWidth) / (barsCount + 1);

    const time = Date.now() * 0.004;

    for (let i = 0; i < barsCount; i++) {
      const x = gap + i * (barWidth + gap);

      let amplitude;
      if (this.isSpeaking) {
        if (this.realAudioAnalyser && this.frequencyDataArray) {
          // Real FFT frequency data from cloned speech audio stream
          this.realAudioAnalyser.getByteFrequencyData(this.frequencyDataArray);
          const binIndex = Math.min(
            this.frequencyDataArray.length - 1,
            Math.floor((i / barsCount) * (this.frequencyDataArray.length * 0.75))
          );
          const rawVal = this.frequencyDataArray[binIndex] / 255.0;
          amplitude = Math.max(0.08, rawVal * 1.1);
        } else {
          // Multi-frequency wave pattern simulating human speech cadence (Browser Web Speech)
          const harmonic1 = Math.sin(time * 2.2 + i * 0.4);
          const harmonic2 = Math.cos(time * 1.5 - i * 0.6);
          const centerBell = Math.sin((i / barsCount) * Math.PI); // taller in the middle
          amplitude = (0.25 + 0.75 * Math.abs(harmonic1 * 0.6 + harmonic2 * 0.4)) * centerBell * this.boundaryEnergy;
        }
      } else {
        // Subtle resting breathing wave
        amplitude = 0.08 + 0.04 * Math.sin(time * 0.8 + i * 0.2);
      }

      const barHeight = Math.max(4, amplitude * (height * 0.85));

      // Gradient color from cyan to indigo
      const grad = ctx.createLinearGradient(0, centerY - barHeight / 2, 0, centerY + barHeight / 2);
      if (this.isSpeaking) {
        grad.addColorStop(0, '#38bdf8');
        grad.addColorStop(0.5, '#818cf8');
        grad.addColorStop(1, '#c084fc');
      } else {
        grad.addColorStop(0, 'rgba(100, 116, 139, 0.4)');
        grad.addColorStop(1, 'rgba(71, 85, 105, 0.2)');
      }

      ctx.fillStyle = grad;
      // Rounded bar
      const radius = barWidth / 2;
      ctx.beginPath();
      ctx.roundRect(x, centerY - barHeight / 2, barWidth, barHeight, radius);
      ctx.fill();
    }
  }

  // --- TAB AUDIO RECORDING ---
  /**
   * Initializes screen/tab capture to record audio output
   * @param {Function} onStatusChange 
   */
  async startRecording(onStatusChange) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      alert('Screen/Tab Audio capture is not supported in this browser.');
      return false;
    }

    try {
      // Prompt user to select this tab and ensure "Share tab audio" is enabled
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required by browser getDisplayMedia specs
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks || audioTracks.length === 0) {
        // User forgot to check "Share tab audio"
        stream.getTracks().forEach(t => t.stop());
        alert('No audio track detected! Please make sure you check the "Share tab audio" checkbox in the browser prompt.');
        return false;
      }

      this.recordingStream = stream;
      this.recordedChunks = [];

      // Create audio-only MediaStream
      const audioOnlyStream = new MediaStream(audioTracks);

      // Support webm audio recording
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      this.mediaRecorder = new MediaRecorder(audioOnlyStream, { mimeType });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this._exportRecordedAudio();
        // Stop all hardware tracks
        if (this.recordingStream) {
          this.recordingStream.getTracks().forEach(t => t.stop());
          this.recordingStream = null;
        }
        this.isRecording = false;
        if (onStatusChange) onStatusChange(false);
      };

      // Handle user clicking "Stop sharing" in browser bar
      audioTracks[0].onended = () => {
        if (this.isRecording) {
          this.stopRecording();
        }
      };

      this.mediaRecorder.start(250);
      this.isRecording = true;
      if (onStatusChange) onStatusChange(true);
      return true;
    } catch (err) {
      console.warn('Tab audio recording cancelled or failed:', err);
      return false;
    }
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  _exportRecordedAudio() {
    if (this.recordedChunks.length === 0) return;

    const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `humanvoice_studio_${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 100);
  }

  // --- SENTENCE & WORD HIGHLIGHT RENDERER ---
  /**
   * Renders the interactive playback sentence cards
   * @param {HTMLElement} container 
   * @param {Array<Object>} chunks 
   * @param {number} activeChunkIdx 
   */
  renderPlaybackCards(container, chunks = [], activeChunkIdx = -1) {
    if (!container) return;
    container.innerHTML = '';

    if (!chunks || chunks.length === 0) {
      container.innerHTML = '<div class="playback-empty">Text chunks will appear here during speech with live highlight.</div>';
      return;
    }

    chunks.forEach((chunk, idx) => {
      if (chunk.isPauseOnly) {
        const pauseBadge = document.createElement('span');
        pauseBadge.className = `chunk-pause-badge ${idx === activeChunkIdx ? 'active' : ''}`;
        pauseBadge.textContent = `⏱️ ${chunk.pauseAfterMs}ms`;
        container.appendChild(pauseBadge);
        return;
      }

      const span = document.createElement('span');
      span.className = `playback-chunk ${idx === activeChunkIdx ? 'active' : ''} ${chunk.isEmphasized ? 'emphasized' : ''}`;
      span.dataset.chunkId = idx;
      span.textContent = chunk.displayText + ' ';
      container.appendChild(span);

      if (idx === activeChunkIdx) {
        // Auto scroll into view smoothly
        span.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  updateActiveChunk(activeChunkIdx, chunks) {
    this.currentChunkIndex = activeChunkIdx;
    this.renderProsodyGraph(chunks, activeChunkIdx);

    const container = document.getElementById('playbackCardsContainer');
    if (container) {
      const prevActive = container.querySelectorAll('.playback-chunk.active, .chunk-pause-badge.active');
      prevActive.forEach(el => el.classList.remove('active'));

      const newActive = container.querySelector(`[data-chunk-id="${activeChunkIdx}"]`);
      if (newActive) {
        newActive.classList.add('active');
        newActive.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  /**
   * Highlights the currently spoken sentence based on backend sidecar timing
   */
  highlightSentenceFromSidecar(sentenceIndex) {
    const container = document.getElementById('playbackCardsContainer');
    if (!container) return;

    const cards = container.querySelectorAll('.playback-chunk');
    cards.forEach((card, idx) => {
      if (idx === sentenceIndex) {
        card.classList.add('active');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        card.classList.remove('active');
      }
    });
  }
}
