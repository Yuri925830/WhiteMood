import type { VoiceSignals } from '../../shared/types';
import { AdaptiveVad, encodeWav, resamplePcm } from './dsp';

interface CaptureCallbacks {
  onUtterance: (blob: Blob, signals: VoiceSignals) => void;
  onSpeechStart: () => void;
  onLevel: (level: number) => void;
  onError: (error: Error) => void;
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

  constructor(private readonly callbacks: CaptureCallbacks, options: { silenceMs?: number } = {}) {
    this.silenceMs = options.silenceMs ?? 1100;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext) throw new Error('Microphone recording requires HTTPS and a supported browser.');
    this.running = true;
    const generation = ++this.generation;
    try {
      // Called only from the user's explicit start action, never during construction.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      }, video: false });
      if (!this.running || generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;
      await context.resume();
      await context.audioWorklet.addModule('/audio/capture.worklet.js');
      if (!this.running || generation !== this.generation) return;
      this.vad = new AdaptiveVad(context.sampleRate, this.silenceMs);
      this.vad.setMuted(this.muted); this.vad.setSpeaking(this.speaking);
      this.source = context.createMediaStreamSource(stream);
      const highpass = context.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 90;
      const lowpass = context.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = Math.min(7500, context.sampleRate * 0.45);
      this.filters = [highpass, lowpass];
      const worklet = new AudioWorkletNode(context, 'whitemood-capture');
      this.worklet = worklet;
      this.source.connect(highpass).connect(lowpass).connect(worklet).connect(context.destination);
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.running || generation !== this.generation || !this.vad) return;
        try {
          const result = this.vad.process(event.data);
          this.callbacks.onLevel(result.level);
          if (result.started) this.callbacks.onSpeechStart();
          if (result.utterance) {
            const { samples, sampleRate, signals } = result.utterance;
            this.callbacks.onUtterance(encodeWav(resamplePcm(samples, sampleRate)), signals);
          }
        } catch (error) { this.fail(error); }
      };
      worklet.onprocessorerror = () => this.fail(new Error('The microphone audio processor stopped. Restart the call.'));
      for (const track of stream.getAudioTracks()) {
        track.onended = () => { if (this.running) this.fail(new Error('Microphone access ended. Restart the call.')); };
      }
    } catch (error) {
      if (generation !== this.generation) return;
      await this.stop();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  setSilenceMs(value: number) { this.silenceMs = value; this.vad?.setSilenceMs(value); }
  setMuted(value: boolean) { this.muted = value; this.vad?.setMuted(value); if (value) this.callbacks.onLevel(0); }
  setSpeaking(value: boolean) { this.speaking = value; this.vad?.setSpeaking(value); }

  async stop(): Promise<void> {
    this.running = false; this.generation++;
    this.vad?.reset(); this.vad = undefined;
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.onprocessorerror = null; this.worklet.port.close(); this.worklet.disconnect(); }
    this.worklet = undefined;
    this.source?.disconnect(); this.source = undefined;
    this.filters.forEach(filter => filter.disconnect()); this.filters = [];
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = undefined;
    const context = this.context; this.context = undefined;
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
    this.callbacks.onLevel(0);
  }

  private fail(error: unknown) {
    if (!this.running) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    void this.stop().then(() => this.callbacks.onError(normalized));
  }
}
