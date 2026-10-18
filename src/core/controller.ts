import type { CallStatus, ChatMessage, Language, ServiceHealth, SessionRecord, UserSettings, VoiceSignals } from '../../shared/types';
import { VoiceCapture } from '../audio/capture';
import { getAvailableVoices, SpeechOutput } from '../audio/speech';
import { getCvAdapter, recentCvObservation, subscribeCvAdapter } from '../integrations/cv';
import type { CvObservation } from '../../shared/types';
import { MemoryStore, selectMemories } from '../memory/store';
import { aborted, api, ApiError, errorKey } from './api';
import { forgetCurrentCall, heardHistory, summaryChunks } from './history';
import type { AppModel } from './model';

export const DEFAULT_SETTINGS: UserSettings = { language: 'zh', rate: 1, silenceMs: 1400, memoryEnabled: false, voiceURI: '', captions: false };
export type ControllerState = Pick<AppModel, 'settings' | 'status' | 'level' | 'elapsedSeconds' | 'messages' | 'error' | 'service' | 'sessions' | 'memories' | 'memoryBusy' | 'muted' | 'availableVoices' | 'cvAvailable' | 'cvEnabled'>;

type CapturePort = Pick<VoiceCapture, 'start' | 'stop' | 'setSilenceMs' | 'setMuted' | 'setSpeaking'>;
type SpeechPort = Pick<SpeechOutput, 'speak' | 'cancel'>;
type CaptureCallbacks = ConstructorParameters<typeof VoiceCapture>[0];

export interface ControllerDependencies {
  api: typeof api;
  store: MemoryStore;
  speech: SpeechPort;
  capture: (callbacks: CaptureCallbacks, settings: UserSettings) => CapturePort;
  voices: typeof getAvailableVoices;
}

export class WhiteMoodController {
  private state: ControllerState = {
    settings: { ...DEFAULT_SETTINGS }, status: 'idle', level: 0, elapsedSeconds: 0, messages: [], error: null,
    service: null, sessions: [], memories: [], memoryBusy: false, muted: false, availableVoices: [], cvAvailable: false, cvEnabled: false,
  };
  private listeners = new Set<() => void>();
  private active = false;
  private ending = false;
  private current: SessionRecord | null = null;
  private retainCall = false;
  private capture: CapturePort | null = null;
  private generation = 0;
  private request: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private maintenance: ReturnType<typeof setInterval> | null = null;
  private persistQueue = Promise.resolve();
  private cvRun: AbortController | null = null;
  private cvObservation: CvObservation | null = null;
  private cvCleanup: (() => void) | null = null;
  private cooldownUntil = 0;
  private attached = false;
  private lifecycle = 0;
  private memoryGeneration = 0;
  private readonly deps: ControllerDependencies;

  constructor(dependencies: Partial<ControllerDependencies> = {}) {
    this.deps = { api, store: new MemoryStore(), speech: new SpeechOutput(), capture: (callbacks, settings) => new VoiceCapture(callbacks, { silenceMs: settings.silenceMs }), voices: getAvailableVoices, ...dependencies };
  }

  getSnapshot = (): ControllerState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(next: Partial<ControllerState>) { this.state = { ...this.state, ...next }; this.listeners.forEach(fn => fn()); }
  private status(status: CallStatus) { this.patch({ status }); }

  async initialize(): Promise<void> {
    const lifecycle = ++this.lifecycle; this.attached = true;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('whitemood-settings-v1') : null;
      if (raw) {
        const parsed: Partial<UserSettings> = JSON.parse(raw);
        // Voice delivery is automatic; obsolete device-specific tuning must not override it.
        this.patch({ settings: this.validSettings({ language: parsed.language, memoryEnabled: parsed.memoryEnabled, captions: parsed.captions }) });
      }
    } catch { /* Private browsing may disable settings persistence. Calls remain available. */ }
    this.refreshVoices();
    this.patch({ cvAvailable: !!getCvAdapter() });
    this.cvCleanup?.();
    this.cvCleanup = subscribeCvAdapter(() => {
      const available = !!getCvAdapter(); this.patch({ cvAvailable: available });
      if (!available) { this.cvRun?.abort(); this.cvRun = null; this.cvObservation = null; this.patch({ cvEnabled: false }); }
    });
    await Promise.all([this.refreshService(), this.reloadMemory()]);
    if (!this.attached || lifecycle !== this.lifecycle) return;
    // Persisted unfinished calls are recoverable; a tab-close event is never relied on for saving.
    if (this.state.settings.memoryEnabled) {
      for (const record of this.state.sessions.filter(s => !s.endedAt)) {
        await this.deps.store.saveSession({ ...record, endedAt: record.messages.at(-1)?.timestamp ?? record.startedAt, summaryStatus: record.messages.some(m => m.role === 'user') ? 'pending' : 'none' });
      }
      await this.reloadMemory();
      void this.runMaintenance();
    }
    if (!this.maintenance) this.maintenance = setInterval(() => { if (!this.active) void this.runMaintenance(); }, 60_000);
  }

  dispose(): void {
    this.attached = false; this.lifecycle++; this.active = false; this.generation++; this.request?.abort(); this.request = null;
    this.deps.speech.cancel(); void this.capture?.stop(); this.capture = null;
    this.cvRun?.abort(); this.cvRun = null; void getCvAdapter()?.stop(); this.cvObservation = null;
    this.cvCleanup?.(); this.cvCleanup = null;
    if (this.timer) clearInterval(this.timer); if (this.maintenance) clearInterval(this.maintenance);
    this.timer = null; this.maintenance = null;
  }

  private validSettings(input: Partial<UserSettings>): UserSettings {
    return {
      language: ['zh', 'en', 'ko'].includes(input.language ?? '') ? input.language! : 'zh',
      rate: Number.isFinite(input.rate) ? Math.min(1.25, Math.max(0.75, input.rate!)) : 1,
      silenceMs: Number.isFinite(input.silenceMs) ? Math.min(3000, Math.max(800, input.silenceMs!)) : 1400,
      memoryEnabled: input.memoryEnabled === true,
      voiceURI: typeof input.voiceURI === 'string' ? input.voiceURI.slice(0, 1000) : '',
      captions: input.captions === true,
    };
  }

  updateSettings = (next: Partial<UserSettings>): void => {
    if (this.active) {
      const { language: _language, voiceURI: _voice, memoryEnabled, ...safe } = next;
      // Consent can always be withdrawn. Enabling storage begins with the next call.
      next = memoryEnabled === false ? { ...safe, memoryEnabled: false } : safe;
    }
    const settings = this.validSettings({ ...this.state.settings, ...next });
    if (settings.memoryEnabled !== this.state.settings.memoryEnabled) {
      this.memoryGeneration++;
      if (!settings.memoryEnabled) this.retainCall = false;
    }
    this.patch({ settings }); this.capture?.setSilenceMs(settings.silenceMs); this.refreshVoices();
    try { localStorage.setItem('whitemood-settings-v1', JSON.stringify(settings)); } catch { /* memory itself has explicit failure handling */ }
    if (!this.active && settings.memoryEnabled) void this.runMaintenance();
  };
  setLanguage = (language: Language) => { if (!this.active) this.updateSettings({ language, voiceURI: '' }); };
  clearError = () => this.patch({ error: null });
  refreshVoices = () => this.patch({ availableVoices: this.deps.voices(this.state.settings.language).map(voice => ({ id: voice.voiceURI, name: voice.name, local: voice.localService })) });

  refreshService = async (): Promise<void> => {
    try { this.patch({ service: await this.deps.api.health() }); }
    catch { this.patch({ service: null, error: 'service_unavailable' }); }
  };

  private beginSession() {
    this.current = { id: crypto.randomUUID(), language: this.state.settings.language, startedAt: Date.now(), messages: [], summaryStatus: 'none' };
    this.active = true; this.retainCall = this.state.settings.memoryEnabled;
    this.patch({ messages: [], elapsedSeconds: 0, error: null });
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { if (this.current) this.patch({ elapsedSeconds: Math.floor((Date.now() - this.current.startedAt) / 1000) }); }, 1000);
    this.persist();
  }

  startCall = async (): Promise<void> => {
    if (this.active || this.ending || this.state.status === 'connecting') return;
    if (!this.state.service?.configured) { this.patch({ error: 'service_unavailable' }); return; }
    this.beginSession(); this.status('connecting'); this.patch({ muted: false });
    const sessionId = this.current!.id;
    const valid = () => this.active && this.capture === capture && this.current?.id === sessionId;
    const capture = this.deps.capture({
      onSpeechStart: () => { if (valid()) this.interrupt(); },
      onUtterance: (blob, signals) => { if (valid()) void this.processAudio(blob, signals); },
      onLevel: level => { if (valid()) this.patch({ level }); },
      onError: error => {
        if (!valid()) return;
        this.interrupt(); this.patch({ error: errorKey(error), muted: true });
        this.capture = null; if (this.active) this.status('listening');
      },
    }, this.state.settings);
    this.capture = capture;
    try {
      await capture.start();
      if (!this.active || this.capture !== capture) { await capture.stop(); return; }
      if (this.getSnapshot().status === 'connecting') this.status('listening');
    } catch (error) {
      if (!valid()) return;
      this.capture = null; this.patch({ error: errorKey(error), muted: true });
      // Keep the real text fallback available without pretending microphone access succeeded.
      this.status('listening');
    }
  };

  private interrupt() {
    this.generation++; this.request?.abort(); this.request = null; this.deps.speech.cancel(); this.capture?.setSpeaking(false);
    if (this.current) {
      const last = this.current.messages.at(-1);
      if (last?.role === 'assistant' && this.state.status === 'speaking') this.replaceMessage(last.id, { interrupted: true });
    }
    if (this.active) this.status('listening');
  }

  stopSpeaking = () => this.interrupt();

  toggleMute = (): void => {
    if (!this.active) return;
    if (!this.capture) { this.patch({ error: 'microphone_missing', muted: true }); return; }
    const muted = !this.state.muted; this.capture.setMuted(muted); this.patch({ muted, level: 0 });
  };

  private async processAudio(audio: Blob, signals: VoiceSignals) {
    if (Date.now() < this.cooldownUntil) { this.patch({ error: 'rate_limited' }); return; }
    this.interrupt(); const generation = this.generation; const request = new AbortController(); this.request = request;
    this.status('transcribing');
    try {
      const result = await this.deps.api.transcribe(audio, this.state.settings.language, request.signal);
      if (!this.active || generation !== this.generation) return;
      const text = result.text.trim();
      if (!text) { this.status('listening'); return; }
      await this.respond(text, signals, generation, request);
    } catch (error) { this.handleTurnError(error, generation); }
  }

  sendText = async (input: string): Promise<void> => {
    if (this.ending) return;
    const text = input.trim().slice(0, 6000); if (!text) return;
    if (!this.state.service?.configured) { this.patch({ error: 'service_unavailable' }); return; }
    if (Date.now() < this.cooldownUntil) { this.patch({ error: 'rate_limited' }); return; }
    if (!this.active) { this.beginSession(); this.patch({ muted: true }); }
    this.interrupt(); const generation = this.generation; const request = new AbortController(); this.request = request;
    try { await this.respond(text, undefined, generation, request); }
    catch (error) { this.handleTurnError(error, generation); }
  };

  private async respond(text: string, voice: VoiceSignals | undefined, generation: number, request: AbortController) {
    if (!this.current) return;
    const sessionId = this.current.id;
    const history = heardHistory(this.current.messages);
    this.addMessage({ id: crypto.randomUUID(), role: 'user', text, timestamp: Date.now() });
    if (forgetCurrentCall(text)) {
      this.retainCall = false; this.memoryGeneration++;
      await this.persistQueue;
      await this.deps.store.deleteSession(sessionId);
      await this.reloadMemory();
      if (!this.active || generation !== this.generation || this.current?.id !== sessionId) return;
    }
    this.status('thinking'); this.patch({ error: null });
    const result = await this.deps.api.respond({ language: this.current.language, text, history,
      memories: this.retainCall && this.state.settings.memoryEnabled ? selectMemories(this.state.memories, text) : [],
      voice, cv: this.state.cvEnabled ? recentCvObservation(this.cvObservation) : undefined,
    }, request.signal);
    if (!this.active || generation !== this.generation || request.signal.aborted) return;
    const message: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', text: result.reply, timestamp: Date.now(), spokenText: '' };
    this.addMessage(message); this.status('speaking'); this.capture?.setSpeaking(true);
    try {
      await this.deps.speech.speak(result.reply, this.current.language, result.speech, this.state.settings, {
        onSentence: sentence => {
          if (!this.active || generation !== this.generation) return;
          const existing = this.current?.messages.find(m => m.id === message.id)?.spokenText ?? '';
          this.replaceMessage(message.id, { spokenText: [existing, sentence].filter(Boolean).join(' ') });
        },
      });
      if (this.active && generation === this.generation) this.status('listening');
    } catch (error) {
      this.replaceMessage(message.id, { interrupted: true });
      if (!aborted(error) && generation === this.generation) this.patch({ error: errorKey(error) === 'voice_unavailable' ? 'voice_unavailable' : 'playback_failed' });
    } finally {
      if (generation === this.generation) { this.capture?.setSpeaking(false); if (this.active) this.status('listening'); }
    }
  }

  private handleTurnError(error: unknown, generation: number) {
    if (aborted(error) || !this.active || generation !== this.generation) return;
    if (error instanceof ApiError && /rate|quota/.test(error.code)) this.cooldownUntil = Date.now() + Math.max(1, error.retryAfter || 30) * 1000;
    this.patch({ error: errorKey(error) }); this.status('listening');
  }

  private addMessage(message: ChatMessage) {
    if (!this.current) return;
    this.current.messages = [...this.current.messages, message]; this.patch({ messages: this.current.messages }); this.persist();
  }

  private replaceMessage(id: string, fields: Partial<ChatMessage>) {
    if (!this.current || !this.current.messages.some(m => m.id === id)) return;
    this.current.messages = this.current.messages.map(m => m.id === id ? { ...m, ...fields } : m);
    this.patch({ messages: this.current.messages }); this.persist();
  }

  private persist() {
    if (!this.current || !this.retainCall) return;
    const record = structuredClone(this.current);
    this.persistQueue = this.persistQueue.then(async () => { await this.deps.store.saveSession(record); }).catch(() => { this.patch({ error: 'storage_error' }); this.retainCall = false; });
  }

  endCall = async (): Promise<void> => {
    if (!this.active || this.ending) return;
    this.ending = true;
    this.active = false; this.interrupt(); this.status('ended'); this.patch({ level: 0 });
    if (this.timer) clearInterval(this.timer); this.timer = null;
    const session = this.current;
    if (session) {
      session.endedAt = Date.now(); session.summaryStatus = session.messages.some(m => m.role === 'user') ? 'pending' : 'none';
      this.persist();
    }
    const retain = this.retainCall; const capture = this.capture; this.capture = null;
    try { await capture?.stop(); await this.setCvEnabled(false); await this.persistQueue; await this.reloadMemory(); }
    catch { this.patch({ error: 'storage_error' }); }
    finally { this.ending = false; }
    if (retain && session?.summaryStatus === 'pending') void this.retrySummary(session.id);
  };

  private async reloadMemory() {
    try {
      const snapshot = await this.deps.store.read();
      this.patch({ sessions: [...snapshot.sessions].sort((a, b) => b.startedAt - a.startedAt), memories: [...snapshot.memories].sort((a, b) => b.updatedAt - a.updatedAt) });
    } catch { this.patch({ error: 'storage_error' }); }
  }

  retrySummary = async (id: string): Promise<void> => {
    if (this.state.memoryBusy || !this.state.settings.memoryEnabled || !this.state.service?.configured) return;
    const record = this.state.sessions.find(s => s.id === id);
    if (!record || !record.endedAt || !record.messages.some(m => m.role === 'user')) return;
    const generation = this.memoryGeneration; this.patch({ memoryBusy: true });
    try {
      await this.deps.store.setSummaryStatus(id, 'pending');
      const parts = [];
      for (const messages of summaryChunks(record.messages)) {
        if (generation !== this.memoryGeneration || !this.state.settings.memoryEnabled) return;
        parts.push(await this.deps.api.summarize({ language: record.language, sessionId: id, messages }));
      }
      const unique = (items: string[]) => [...new Set(items)];
      const result = { summary: {
        text: parts.map(part => part.summary.text).join('\n'),
        selfReported: unique(parts.flatMap(part => part.summary.selfReported)),
        preferences: unique(parts.flatMap(part => part.summary.preferences)),
        followUp: unique(parts.flatMap(part => part.summary.followUp)),
      }, memories: parts.flatMap(part => part.memories) };
      if (generation === this.memoryGeneration && this.state.settings.memoryEnabled) await this.deps.store.commitSummary(id, result);
    } catch { await this.deps.store.setSummaryStatus(id, 'failed').catch(() => undefined); this.patch({ error: 'summary_failed' }); }
    finally { this.patch({ memoryBusy: false }); await this.reloadMemory(); }
  };

  private async runMaintenance() {
    if (!this.attached || this.active || this.state.memoryBusy || !this.state.settings.memoryEnabled || !this.state.service?.configured) return;
    const generation = this.memoryGeneration;
    const pending = this.state.sessions.find(s => s.endedAt && s.summaryStatus === 'pending');
    if (pending) { await this.retrySummary(pending.id); return; }
    const snapshot = await this.deps.store.read().catch(() => null);
    // A browser read can outlive a consent change, deletion, or a newly started call.
    // Re-check before sending any saved content to the provider, not only before committing.
    if (!this.attached || this.active || this.state.memoryBusy || !this.state.settings.memoryEnabled || generation !== this.memoryGeneration) return;
    if (!snapshot || Date.now() - snapshot.lastConsolidatedAt < 24 * 60 * 60 * 1000) return;
    const summaries = snapshot.sessions.filter(s => s.summary && s.endedAt && !snapshot.excludedSourceIds.includes(s.id)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 30)
      .map(s => ({ id: s.id, endedAt: s.endedAt!, summary: {
        text: s.summary!.text.slice(0, 4000), selfReported: s.summary!.selfReported.slice(0, 12),
        preferences: s.summary!.preferences.slice(0, 12), followUp: s.summary!.followUp.slice(0, 12),
      } }));
    if (!summaries.length) return;
    const validIds = new Set(summaries.map(s => s.id)); this.patch({ memoryBusy: true });
    try {
      const result = await this.deps.api.consolidate({ language: this.state.settings.language, summaries, existing: snapshot.memories.filter(m => m.sourceSessionIds.every(id => validIds.has(id))).slice(0, 80) });
      if (generation === this.memoryGeneration && this.state.settings.memoryEnabled) await this.deps.store.applyConsolidation(snapshot.revision, result, summaries.map(s => s.id));
    } catch { /* Leave the timestamp unchanged so a later real opportunity can retry. */ }
    finally { this.patch({ memoryBusy: false }); await this.reloadMemory(); }
  }

  deleteSession = async (id: string) => {
    try {
      if (this.current?.id === id) this.retainCall = false;
      this.memoryGeneration++; await this.persistQueue; await this.deps.store.deleteSession(id); await this.reloadMemory();
    } catch { this.patch({ error: 'storage_error' }); }
  };
  deleteMemory = async (id: string) => { try { this.memoryGeneration++; await this.deps.store.deleteMemory(id); await this.reloadMemory(); } catch { this.patch({ error: 'storage_error' }); } };
  editMemory = async (id: string, text: string) => { try { this.memoryGeneration++; await this.deps.store.editMemory(id, text); await this.reloadMemory(); } catch { this.patch({ error: 'storage_error' }); } };
  clearAllMemory = async () => {
    this.retainCall = false; this.memoryGeneration++;
    try { await this.persistQueue; await this.deps.store.clear(); }
    catch { this.patch({ error: 'storage_error' }); return; }
    this.patch({ settings: { ...this.state.settings, memoryEnabled: false } });
    try { localStorage.setItem('whitemood-settings-v1', JSON.stringify(this.state.settings)); } catch { /* no persisted setting */ }
    await this.reloadMemory();
  };

  setCvEnabled = async (enabled: boolean): Promise<void> => {
    this.cvRun?.abort(); this.cvRun = null; this.cvObservation = null;
    const adapter = getCvAdapter();
    if (!enabled || !adapter || !this.active) { await adapter?.stop(); this.patch({ cvEnabled: false }); return; }
    const run = new AbortController(); this.cvRun = run;
    try {
      await adapter.start({ signal: run.signal, onObservation: value => { if (!run.signal.aborted) this.cvObservation = value; } });
      if (!run.signal.aborted && this.active) this.patch({ cvEnabled: true }); else await adapter.stop();
    } catch { run.abort(); await adapter.stop(); this.patch({ cvEnabled: false, error: 'cv_error' }); }
  };
}
