import type { MicrophoneState, VoiceSignals } from '../../shared/types';
import { AdaptiveVad, encodeWav, resamplePcm } from './dsp';

interface CaptureCallbacks {
  onUtterance: (blob: Blob, signals: VoiceSignals) => void;
  onSpeechStart: () => void;
  onLevel: (level: number) => void;
  onError: (error: Error) => void;
  onState?: (state: MicrophoneState) => void;
}

export class MicrophoneError extends Error {
  constructor(readonly code: 'microphone_interrupted' | 'microphone_stalled') { super(code); this.name = 'MicrophoneError'; }
}

export class VoiceCapture {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private filters: BiquadFilterNode[] = [];
  private vad?: AdaptiveVad;
  private generation = 0;
  private running = false;
  private silenceMs: number;
  private muted = false;
  private speaking = false;
  private deviceLabel = '';
  private inputState: MicrophoneState['status'] = 'idle';
  private monitor?: ReturnType<typeof setInterval>;
  private lastFrameAt = 0;
  private lastSignalAt = 0;
  private interruptedAt = 0;

  constructor(private readonly callbacks: CaptureCallbacks, options: { silenceMs?: number } = {}) {
    this.silenceMs = options.silenceMs ?? 1100;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext || !globalThis.AudioWorkletNode) throw new Error('Unsupported microphone recording: use HTTPS and a current browser with AudioWorklet.');
    this.running = true;
    const generation = ++this.generation;
    this.report('starting');
    try {
      // Unlock the native audio context synchronously in the Start/Retry click. Waiting for
      // getUserMedia first can lose that gesture on browsers with autoplay restrictions.
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;
      const resumed = context.resume();
      // Observe a rejected resume even if microphone permission is still pending.
      void resumed.catch(() => undefined);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      }, video: false });
      if (!this.running || generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.every(track => track.readyState === 'ended')) throw new DOMException('No live microphone track.', 'NotReadableError');
      this.deviceLabel = tracks[0].label || '';
      await withTimeout(resumed, 5000);
      if (!this.running || generation !== this.generation) return;
      if (context.state !== 'running') throw new MicrophoneError('microphone_interrupted');
      await context.audioWorklet.addModule('/audio/capture.worklet.js');
      if (!this.running || generation !== this.generation) return;
      this.vad = new AdaptiveVad(context.sampleRate, this.silenceMs);
      this.vad.setMuted(this.muted); this.vad.setSpeaking(this.speaking);
      this.source = context.createMediaStreamSource(stream);
      const highpass = context.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 70;
      const lowpass = context.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = Math.min(7500, context.sampleRate * 0.45);
      this.filters = [highpass, lowpass];
      const worklet = new AudioWorkletNode(context, 'whitemood-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      this.worklet = worklet;
      const now = Date.now(); this.lastFrameAt = now; this.lastSignalAt = now; this.interruptedAt = 0;
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.running || generation !== this.generation || !this.vad) return;
        if (!(event.data instanceof Float32Array) || !event.data.length) return;
        try {
          this.lastFrameAt = Date.now();
          const result = this.vad.process(event.data);
          if (result.level > 0.04) this.lastSignalAt = this.lastFrameAt;
          this.callbacks.onLevel(result.level);
          // Ready means the processor has delivered actual PCM, not merely that permission exists.
          if (this.inputState === 'starting' || (this.inputState === 'quiet' && result.level > 0.04)) this.report('ready');
          if (result.started) { this.report('hearing'); this.callbacks.onSpeechStart(); }
          if (result.ended) this.report('ready');
          if (result.utterance) {
            const { samples, sampleRate, signals } = result.utterance;
            this.report('ready');
            this.callbacks.onUtterance(encodeWav(resamplePcm(samples, sampleRate)), signals);
          }
        } catch (error) { this.fail(error); }
      };
      worklet.onprocessorerror = () => this.fail(new MicrophoneError('microphone_stalled'));
      for (const track of tracks) {
        track.onended = () => { if (this.running) this.fail(new MicrophoneError('microphone_interrupted')); };
        track.onmute = () => { if (this.running) { this.interruptedAt ||= Date.now(); this.vad?.reset(); this.report('interrupted'); this.callbacks.onLevel(0); } };
        track.onunmute = () => { if (this.running && context.state === 'running') { this.interruptedAt = 0; this.lastSignalAt = Date.now(); this.report('starting'); } };
      }
      context.onstatechange = () => {
        if (!this.running || generation !== this.generation) return;
        if (context.state !== 'running') { this.interruptedAt ||= Date.now(); this.vad?.reset(); this.report('interrupted'); this.callbacks.onLevel(0); }
        else if (!tracks.some(track => track.muted)) { this.interruptedAt = 0; this.report('starting'); }
      };
      // A real silent-output connection keeps WebKit's pull-based audio graph processing.
      this.source.connect(highpass).connect(lowpass).connect(worklet).connect(context.destination);
      this.monitor = setInterval(() => {
        if (!this.running || generation !== this.generation) return;
        const now = Date.now();
        if (this.interruptedAt && now - this.interruptedAt > 4000) { this.fail(new MicrophoneError('microphone_interrupted')); return; }
        if (!this.interruptedAt && now - this.lastFrameAt > 4000) { this.fail(new MicrophoneError('microphone_stalled')); return; }
        if (!this.muted && !this.speaking && !this.interruptedAt && this.inputState !== 'hearing' && now - this.lastSignalAt > 6000) this.report('quiet');
      }, 500);
      if (tracks.some(track => track.muted)) { this.interruptedAt = Date.now(); this.report('interrupted'); }
    } catch (error) {
      if (generation !== this.generation) return;
      await this.stop();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  setSilenceMs(value: number) { this.silenceMs = value; this.vad?.setSilenceMs(value); }
  setMuted(value: boolean) { this.muted = value; this.vad?.setMuted(value); if (value) this.callbacks.onLevel(0); else this.lastSignalAt = Date.now(); }
  setSpeaking(value: boolean) { this.speaking = value; this.vad?.setSpeaking(value); }

  async stop(): Promise<void> {
    this.running = false; this.generation++;
    if (this.monitor) clearInterval(this.monitor); this.monitor = undefined;
    this.vad?.reset(); this.vad = undefined;
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.onprocessorerror = null; this.worklet.port.close(); this.worklet.disconnect(); }
    this.worklet = undefined;
    this.source?.disconnect(); this.source = undefined;
    this.filters.forEach(filter => filter.disconnect()); this.filters = [];
    this.stream?.getTracks().forEach(track => { track.onended = null; track.onmute = null; track.onunmute = null; track.stop(); }); this.stream = undefined;
    const context = this.context; this.context = undefined;
    if (context) context.onstatechange = null;
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
    this.callbacks.onLevel(0);
    this.report('idle');
  }

  private report(status: MicrophoneState['status']) {
    if (this.inputState === status) return;
    this.inputState = status; this.callbacks.onState?.({ status, ...(this.deviceLabel ? { deviceLabel: this.deviceLabel } : {}) });
  }

  private fail(error: unknown) {
    if (!this.running) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    void this.stop().then(() => this.callbacks.onError(normalized));
  }
}

function withTimeout(promise: Promise<void>, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MicrophoneError('microphone_interrupted')), ms);
    promise.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });
}
