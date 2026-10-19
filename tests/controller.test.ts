import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidateRequest, ConsolidateResult, Language, RespondRequest, RespondResult, SpeechPlan, SummarizeRequest, SummarizeResult, UserSettings } from '../shared/types';
import { WhiteMoodController } from '../src/core/controller';
import type { ControllerDependencies } from '../src/core/controller';
import { ApiError } from '../src/core/api';
import { registerCvAdapter } from '../src/integrations/cv';
import { MemoryStore } from '../src/memory/store';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

const response: RespondResult = { reply: 'First sentence. Second sentence.', speech: { style: 'steady', rate: 1, pitch: 1, pauseMs: 250 }, reflection: { feeling: 'uncertain', evidence: [], uncertain: true } };
const signals = { durationMs: 1200, voicedRatio: 0.6, meanEnergy: 0.03, peakEnergy: 0.08 };
const controllers: WhiteMoodController[] = [];
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function setup(options: { captureStart?: Promise<void>; captureStop?: Promise<void> } = {}) {
  const store = new MemoryStore(`controller-test-${crypto.randomUUID()}`);
  const save = vi.spyOn(store, 'saveSession');
  const commit = vi.spyOn(store, 'commitSummary');
  const api = {
    health: vi.fn(async () => ({ configured: true, provider: 'groq' as const, models: { chat: 'test-only', stt: 'test-only' } })),
    transcribe: vi.fn(async (_audio: Blob, _language: Language, _signal?: AbortSignal) => ({ text: 'User said this.' })),
    respond: vi.fn(async (_body: RespondRequest, _signal?: AbortSignal): Promise<RespondResult> => structuredClone(response)),
    summarize: vi.fn(async (_body: SummarizeRequest, _signal?: AbortSignal): Promise<SummarizeResult> => ({ summary: { text: 'Test summary', selfReported: [], preferences: [], followUp: [] }, memories: [] })),
    consolidate: vi.fn(async (_body: ConsolidateRequest, _signal?: AbortSignal): Promise<ConsolidateResult> => ({ memories: [] })),
  };
  type CaptureCallbacks = Parameters<ControllerDependencies['capture']>[0];
  const captures: Array<{ callbacks: CaptureCallbacks; start: ReturnType<typeof vi.fn<() => Promise<void>>>; stop: ReturnType<typeof vi.fn<() => Promise<void>>>; setSpeaking: ReturnType<typeof vi.fn> }> = [];
  const capture = vi.fn((callbacks: CaptureCallbacks) => {
    const value = { callbacks, start: vi.fn(async () => { await (options.captureStart ?? Promise.resolve()); callbacks.onState?.({ status: 'ready' }); }), stop: vi.fn(() => options.captureStop ?? Promise.resolve()), setSilenceMs: vi.fn(), setMuted: vi.fn(), setSpeaking: vi.fn() };
    captures.push(value); return value;
  });
  const playback: Array<ReturnType<typeof deferred<void>> & { callbacks: { onSentence: (text: string) => void }; canceled: boolean }> = [];
  const speech = {
    speak: vi.fn((_text: string, _language: Language, _plan: SpeechPlan, _settings: UserSettings, callbacks: { onSentence: (text: string) => void }) => {
      const value = { ...deferred<void>(), callbacks, canceled: false }; playback.push(value); return value.promise;
    }),
    cancel: vi.fn(() => { for (const item of playback) if (!item.canceled) { item.canceled = true; item.reject(new DOMException('Interrupted', 'AbortError')); } }),
  };
  const controller = new WhiteMoodController({ api, store, capture, speech, voices: () => [] });
  controllers.push(controller); await controller.initialize();
  return { controller, api, store, save, commit, captures, capture, speech, playback };
}

afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.unstubAllGlobals(); });

describe('call orchestration uses real lifecycle boundaries', () => {
  it('queues selected images for one spoken turn and then clears the input state', async () => {
    const frames = [
      { image: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), capturedAt: Date.now() },
      { image: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), capturedAt: Date.now() },
    ];
    const adapter = { setImages: vi.fn(async () => 2), start: vi.fn(async () => undefined), stop: vi.fn(), takeFrames: vi.fn(() => frames) };
    const unregister = registerCvAdapter(adapter);
    try {
      const test = await setup(); await test.controller.startCall();
      await test.controller.setCvImages([
        new File(['one'], 'one.png', { type: 'image/png' }),
        new File(['two'], 'two.png', { type: 'image/png' }),
      ]);
      expect(test.controller.getSnapshot()).toMatchObject({ cvEnabled: true, cvInputCount: 2 });
      test.captures[0].callbacks.onUtterance(new Blob(['PCM']), signals); await flush();
      const transcribeCall = test.api.transcribe.mock.calls[0] as unknown[];
      expect(transcribeCall[3]).toEqual(frames);
      expect(test.controller.getSnapshot()).toMatchObject({ cvEnabled: false, cvInputCount: 0 });
      test.playback[0].resolve(); await flush();
    } finally { unregister(); }
  });

  it('connects the microphone after a text-first conversation without discarding its messages', async () => {
    const test = await setup();
    const turn = test.controller.sendText('Start with a written thought'); await flush();
    test.playback[0].resolve(); await turn;
    expect(test.captures).toHaveLength(0);
    const messages = test.controller.getSnapshot().messages;
    test.controller.toggleMute(); await flush();
    expect(test.captures).toHaveLength(1);
    expect(test.controller.getSnapshot().microphone.status).toBe('ready');
    expect(test.controller.getSnapshot().messages).toEqual(messages);
    expect(test.controller.getSnapshot().muted).toBe(false);
    test.captures[0].callbacks.onUtterance(new Blob(['quiet PCM']), signals); await flush();
    expect(test.api.transcribe).toHaveBeenCalledOnce();
    test.playback[1].resolve(); await flush();
  });

  it('retries a failed microphone in the current call and ignores the discarded processor callbacks', async () => {
    const test = await setup(); await test.controller.startCall();
    const oldCapture = test.captures[0];
    oldCapture.callbacks.onError(new Error('Microphone stopped'));
    expect(test.controller.getSnapshot().microphone.status).toBe('error');
    await test.controller.restartMicrophone();
    expect(test.captures).toHaveLength(2);
    oldCapture.callbacks.onState?.({ status: 'interrupted' });
    oldCapture.callbacks.onUtterance(new Blob(['stale']), signals);
    expect(test.controller.getSnapshot().microphone.status).toBe('ready');
    expect(test.controller.getSnapshot().error).toBe(null);
    expect(test.api.transcribe).not.toHaveBeenCalled();
  });

  it('explains an empty transcription while keeping capture available for another try', async () => {
    const test = await setup(); await test.controller.startCall();
    test.api.transcribe.mockResolvedValueOnce({ text: '' });
    test.captures[0].callbacks.onUtterance(new Blob(['unclear PCM']), signals); await flush();
    expect(test.controller.getSnapshot().microphone.status).toBe('unclear');
    expect(test.controller.getSnapshot().status).toBe('listening');
    expect(test.api.respond).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])('restores only simple preferences and explicit captions=%s', async captions => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ language: 'ko', memoryEnabled: false, captions, voiceURI: 'obsolete-device-voice', rate: 1.25, silenceMs: 3000 }), setItem: vi.fn() });
    const test = await setup();
    expect(test.controller.getSnapshot().settings).toEqual({ language: 'ko', memoryEnabled: false, captions: captions === true, voiceURI: '', rate: 1, silenceMs: 1400 });
  });

  it('starts with captions collapsed when no preference was saved', async () => {
    const test = await setup();
    expect(test.controller.getSnapshot().settings.captions).toBe(false);
  });

  it.each(['thinking', 'speaking'] as const)('does not overwrite %s when microphone permission finishes late', async expectedStatus => {
    const permission = deferred<void>(); const reply = deferred<RespondResult>();
    const test = await setup({ captureStart: permission.promise });
    if (expectedStatus === 'thinking') test.api.respond.mockImplementationOnce(() => reply.promise);
    const starting = test.controller.startCall();
    const turn = test.controller.sendText('Question during connection'); await flush();
    expect(test.controller.getSnapshot().status).toBe(expectedStatus);
    permission.resolve(); await starting;
    expect(test.controller.getSnapshot().status).toBe(expectedStatus);
    if (expectedStatus === 'thinking') { reply.resolve(response); await flush(); }
    test.playback[0].resolve(); await turn;
  });

  it('drops transcription arriving after the user interrupts it', async () => {
    const test = await setup(); const pending = deferred<{ text: string }>();
    test.api.transcribe.mockImplementationOnce(() => pending.promise);
    await test.controller.startCall();
    test.captures[0].callbacks.onUtterance(new Blob(['pcm']), signals);
    expect(test.controller.getSnapshot().status).toBe('transcribing');
    test.captures[0].callbacks.onSpeechStart();
    expect(test.api.transcribe.mock.calls[0][2]?.aborted).toBe(true);
    pending.resolve({ text: 'A superseded transcript' }); await flush();
    expect(test.api.respond).not.toHaveBeenCalled();
    expect(test.speech.speak).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot().messages).toEqual([]);
    expect(test.controller.getSnapshot().status).toBe('listening');
  });

  it('does not play a late AI reply after ending and opening another call', async () => {
    const test = await setup(); const pending = deferred<RespondResult>();
    test.api.respond.mockImplementationOnce(() => pending.promise);
    await test.controller.startCall();
    const turn = test.controller.sendText('Old call question'); await flush();
    await test.controller.endCall(); await test.controller.startCall();
    pending.resolve(response); await turn;
    expect(test.speech.speak).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot().messages).toEqual([]);
    expect(test.captures[0].stop).toHaveBeenCalled();
    expect(test.controller.getSnapshot().status).toBe('listening');
  });

  it('sends only confirmed played sentences into the next response context', async () => {
    const test = await setup(); await test.controller.startCall();
    const first = test.controller.sendText('First user turn'); await flush();
    expect(test.playback).toHaveLength(1);
    test.playback[0].callbacks.onSentence('First sentence.');
    test.captures[0].callbacks.onSpeechStart(); await first;
    const second = test.controller.sendText('Please continue'); await flush();
    const history = test.api.respond.mock.calls[1][0].history;
    expect(history.map(message => message.text)).toEqual(['First user turn', 'First sentence.']);
    expect(history.some(message => message.text.includes('Second sentence'))).toBe(false);
    expect(test.controller.getSnapshot().messages.find(message => message.role === 'assistant')?.interrupted).toBe(true);
    test.controller.stopSpeaking(); await second;
  });

  it('never persists a call or starts summary/consolidation while memory defaults off', async () => {
    const test = await setup(); await test.controller.startCall();
    const turn = test.controller.sendText('This stays in this call'); await flush();
    test.playback[0].callbacks.onSentence(response.reply); test.playback[0].resolve(); await turn;
    await test.controller.endCall(); await flush();
    expect(test.save).not.toHaveBeenCalled();
    expect(test.commit).not.toHaveBeenCalled();
    expect(test.api.summarize).not.toHaveBeenCalled();
    expect(test.api.consolidate).not.toHaveBeenCalled();
    expect((await test.store.read()).sessions).toEqual([]);
  });

  it('aborts requests and releases capture when the controller is disposed', async () => {
    const test = await setup(); const pending = deferred<RespondResult>();
    test.api.respond.mockImplementationOnce(() => pending.promise);
    await test.controller.startCall();
    const turn = test.controller.sendText('Question before unmount'); await flush();
    test.controller.dispose();
    expect(test.api.respond.mock.calls[0][1]?.aborted).toBe(true);
    expect(test.captures[0].stop).toHaveBeenCalledOnce();
    pending.resolve(response); await turn;
    expect(test.speech.speak).not.toHaveBeenCalled();
  });

  it('ignores stale callbacks from a microphone belonging to an ended call', async () => {
    const test = await setup(); await test.controller.startCall();
    const oldCapture = test.captures[0];
    await test.controller.endCall(); await test.controller.startCall();
    oldCapture.callbacks.onUtterance(new Blob(['old pcm']), signals);
    oldCapture.callbacks.onLevel(0.8);
    oldCapture.callbacks.onError(new Error('Old capture failure'));
    await flush();
    expect(test.api.transcribe).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot().level).toBe(0);
    expect(test.controller.getSnapshot().error).toBe(null);
    expect(test.controller.getSnapshot().muted).toBe(false);
  });

  it('does not label fully played multilingual replies as interrupted due to added sentence spaces', async () => {
    const test = await setup(); await test.controller.startCall();
    test.api.respond.mockResolvedValueOnce({ ...response, reply: '你好。今天好吗？' });
    const turn = test.controller.sendText('你好'); await flush();
    test.playback[0].callbacks.onSentence('你好。'); test.playback[0].callbacks.onSentence('今天好吗？');
    test.playback[0].resolve(); await turn;
    await test.controller.endCall();
    expect(test.controller.getSnapshot().messages.find(message => message.role === 'assistant')?.interrupted).not.toBe(true);
  });

  it('ignores microphone permission rejection arriving after the call has ended', async () => {
    const permission = deferred<void>();
    const test = await setup({ captureStart: permission.promise });
    const starting = test.controller.startCall();
    await test.controller.endCall();
    permission.reject(new DOMException('Denied', 'NotAllowedError')); await starting;
    expect(test.controller.getSnapshot().status).toBe('ended');
    expect(test.controller.getSnapshot().error).toBe(null);
  });

  it('waits for old capture teardown before accepting a new call', async () => {
    const stopping = deferred<void>();
    const test = await setup({ captureStop: stopping.promise }); await test.controller.startCall();
    const ending = test.controller.endCall();
    await test.controller.startCall();
    expect(test.captures).toHaveLength(1);
    stopping.resolve(); await ending;
    await test.controller.startCall();
    expect(test.captures).toHaveLength(2);
    expect(test.controller.getSnapshot().status).toBe('listening');
  });

  it('summarizes all retained conversation messages, beyond the short reply-history window', async () => {
    const test = await setup(); const id = crypto.randomUUID();
    const messages = Array.from({ length: 20 }, (_, index) => ({ id: `m-${index}`, role: 'user' as const, text: `Retained user statement ${index}`, timestamp: Date.now() + index }));
    await test.store.saveSession({ id, language: 'en', startedAt: Date.now() - 10000, endedAt: Date.now(), summaryStatus: 'pending', messages });
    await test.controller.initialize();
    test.controller.updateSettings({ memoryEnabled: true });
    await vi.waitFor(() => expect(test.api.summarize).toHaveBeenCalled());
    const summarized = test.api.summarize.mock.calls.flatMap(([request]) => request.messages.map(message => message.id));
    expect(summarized).toEqual(messages.map(message => message.id));
    await vi.waitFor(() => expect(test.controller.getSnapshot().memoryBusy).toBe(false));
  });

  it.each(['withdraw-consent', 'off-on', 'delete-source', 'start-call', 'dispose'] as const)(
    'does not send a deferred memory snapshot after %s', async action => {
      const test = await setup(); const id = crypto.randomUUID();
      await test.store.saveSession({ id, language: 'en', startedAt: Date.now() - 10000, endedAt: Date.now(), summaryStatus: 'ready', messages: [],
        summary: { text: 'A private retained event', selfReported: ['A private retained event'], preferences: [], followUp: [] },
      });
      const staleSnapshot = await test.store.read();
      const reading = deferred<typeof staleSnapshot>();
      const read = vi.spyOn(test.store, 'read').mockImplementationOnce(() => reading.promise);
      test.controller.updateSettings({ memoryEnabled: true });
      expect(read).toHaveBeenCalledOnce();
      if (action === 'withdraw-consent') test.controller.updateSettings({ memoryEnabled: false });
      if (action === 'off-on') {
        // A fresh task may proceed under new consent; the old snapshot must still be invalid.
        read.mockResolvedValueOnce({ ...staleSnapshot, lastConsolidatedAt: Date.now() });
        test.controller.updateSettings({ memoryEnabled: false });
        test.controller.updateSettings({ memoryEnabled: true });
        await flush();
      }
      if (action === 'delete-source') await test.controller.deleteSession(id);
      if (action === 'start-call') await test.controller.startCall();
      if (action === 'dispose') test.controller.dispose();
      reading.resolve(staleSnapshot); await flush();
      expect(test.api.consolidate).not.toHaveBeenCalled();
      expect(test.controller.getSnapshot().memoryBusy).toBe(false);
    },
  );

  it('lets an active caller stop memory immediately, cannot re-enable mid-call, and saves again next call', async () => {
    const test = await setup(); const sourceId = crypto.randomUUID();
    await test.store.saveSession({ id: sourceId, language: 'en', startedAt: Date.now() - 10000, endedAt: Date.now() - 1000, summaryStatus: 'pending', messages: [] });
    await test.store.commitSummary(sourceId, { summary: { text: 'Prefers short replies', preferences: ['Short replies'], selfReported: [], followUp: [] },
      memories: [{ kind: 'preference', text: 'Prefers short replies', sourceSessionIds: [sourceId] }],
    });
    await test.controller.initialize(); test.controller.updateSettings({ memoryEnabled: true });
    await test.controller.startCall();
    const first = test.controller.sendText('First retained question'); await flush();
    expect(test.api.respond.mock.calls[0][0].memories).toHaveLength(1);
    test.playback[0].callbacks.onSentence(response.reply); test.playback[0].resolve(); await first;
    test.controller.updateSettings({ memoryEnabled: false });
    expect(test.controller.getSnapshot().settings.memoryEnabled).toBe(false);
    test.controller.updateSettings({ memoryEnabled: true });
    expect(test.controller.getSnapshot().settings.memoryEnabled).toBe(false);
    const second = test.controller.sendText('Private question after withdrawal'); await flush();
    expect(test.api.respond.mock.calls[1][0].memories).toEqual([]);
    test.playback[1].callbacks.onSentence(response.reply); test.playback[1].resolve(); await second;
    await test.controller.endCall();
    const retained = (await test.store.read()).sessions.flatMap(session => session.messages);
    expect(retained.some(message => message.text === 'First retained question')).toBe(true);
    expect(retained.some(message => message.text === 'Private question after withdrawal')).toBe(false);
    expect(test.api.summarize).not.toHaveBeenCalled();
    test.controller.updateSettings({ memoryEnabled: true });
    await test.controller.startCall();
    const next = test.controller.sendText('A new consenting call'); await flush();
    test.playback[2].callbacks.onSentence(response.reply); test.playback[2].resolve(); await next;
    await test.controller.endCall();
    expect((await test.store.read()).sessions.some(session => session.messages.some(message => message.text === 'A new consenting call'))).toBe(true);
    await vi.waitFor(() => expect(test.controller.getSnapshot().memoryBusy).toBe(false));
  });

  it('does not commit an old summary after memory is switched off and on', async () => {
    const test = await setup(); const pending = deferred<SummarizeResult>(); const id = crypto.randomUUID();
    await test.store.saveSession({ id, language: 'en', startedAt: Date.now() - 1000, endedAt: Date.now(), summaryStatus: 'pending', messages: [{ id: 'u', role: 'user', text: 'A retained statement', timestamp: Date.now() }] });
    await test.controller.initialize();
    test.api.summarize.mockImplementationOnce(() => pending.promise);
    test.controller.updateSettings({ memoryEnabled: true });
    await vi.waitFor(() => expect(test.api.summarize).toHaveBeenCalledOnce());
    test.controller.updateSettings({ memoryEnabled: false });
    test.controller.updateSettings({ memoryEnabled: true });
    pending.resolve({ summary: { text: 'An obsolete summary', selfReported: [], preferences: [], followUp: [] }, memories: [] });
    await vi.waitFor(() => expect(test.controller.getSnapshot().memoryBusy).toBe(false));
    expect(test.commit).not.toHaveBeenCalled();
  });

  it('resumes after a summary quota failure without repeating already successful blocks', async () => {
    const test = await setup(); const id = crypto.randomUUID();
    const messages = Array.from({ length: 2 }, (_, index) => [
      { id: `u${index}`, role: 'user' as const, text: '中文'.repeat(250), timestamp: index * 2 },
      { id: `a${index}`, role: 'assistant' as const, text: '한국어'.repeat(70), spokenText: '한국어'.repeat(70), timestamp: index * 2 + 1 },
    ]).flat();
    await test.store.saveSession({ id, language: 'zh', startedAt: Date.now() - 1000, endedAt: Date.now(), summaryStatus: 'pending', messages });
    await test.controller.initialize();
    const part = (text: string): SummarizeResult => ({ summary: { text, selfReported: [text], preferences: [], followUp: [] }, memories: [{ kind: 'event', text, sourceSessionIds: [id] }] });
    test.api.summarize.mockResolvedValueOnce(part('First successful block')).mockRejectedValueOnce(new ApiError('rate_limited', 60));
    test.controller.updateSettings({ memoryEnabled: true });
    await vi.waitFor(() => { expect(test.api.summarize).toHaveBeenCalledTimes(2); expect(test.controller.getSnapshot().memoryBusy).toBe(false); });
    expect(test.commit).not.toHaveBeenCalled();
    expect(test.controller.getSnapshot().sessions.find(session => session.id === id)?.summaryStatus).toBe('failed');
    test.api.summarize.mockResolvedValueOnce(part('Second resumed block'));
    await test.controller.retrySummary(id);
    expect(test.api.summarize.mock.calls.map(([request]) => request.messages.map(message => message.id))).toEqual([['u0', 'a0'], ['u1', 'a1'], ['u1', 'a1']]);
    const saved = (await test.store.read()).sessions.find(session => session.id === id);
    expect(saved?.summary?.text).toBe('First successful block\nSecond resumed block');
    expect(saved?.summary?.selfReported).toEqual(['First successful block', 'Second resumed block']);
    expect(test.commit).toHaveBeenCalledOnce();
  });

  it.each(['off-on', 'version', 'delete', 'dispose'] as const)('invalidates an in-flight summary checkpoint after %s', async action => {
    const test = await setup(); const id = crypto.randomUUID(); const second = deferred<SummarizeResult>();
    const messages = Array.from({ length: 2 }, (_, index) => ({ id: `long-u${index}`, role: 'user' as const, text: '中'.repeat(1000), timestamp: index }));
    const record = { id, language: 'zh' as const, startedAt: Date.now() - 1000, endedAt: Date.now(), summaryStatus: 'pending' as const, messages };
    await test.store.saveSession(record); await test.controller.initialize();
    test.api.summarize.mockResolvedValueOnce({ summary: { text: 'Old first block', selfReported: [], preferences: [], followUp: [] }, memories: [] }).mockImplementationOnce(() => second.promise);
    test.controller.updateSettings({ memoryEnabled: true });
    await vi.waitFor(() => expect(test.api.summarize).toHaveBeenCalledTimes(2));
    if (action === 'off-on') { test.controller.updateSettings({ memoryEnabled: false }); test.controller.updateSettings({ memoryEnabled: true }); }
    if (action === 'version') {
      await test.store.saveSession({ ...record, messages: [{ ...messages[0], text: 'New version. ' + messages[0].text }, messages[1]] });
      await test.controller.initialize();
    }
    if (action === 'delete') await test.controller.deleteSession(id);
    if (action === 'dispose') test.controller.dispose();
    second.resolve({ summary: { text: 'Obsolete second block', selfReported: [], preferences: [], followUp: [] }, memories: [] });
    await vi.waitFor(() => expect(test.controller.getSnapshot().memoryBusy).toBe(false));
    expect(test.commit).not.toHaveBeenCalled();
    if (action === 'off-on' || action === 'version') {
      await test.controller.retrySummary(id);
      expect(test.api.summarize.mock.calls[2][0].messages[0].id).toBe('long-u0');
      expect(test.api.summarize).toHaveBeenCalledTimes(4);
    }
  });

  it('projects at most32 source IDs into a response without altering the retained memory', async () => {
    const test = await setup();
    for (let index = 0; index < 33; index++) {
      const id = `source-${index}`;
      await test.store.saveSession({ id, language: 'en', startedAt: index, endedAt: index + 1, summaryStatus: 'pending', messages: [] });
      await test.store.commitSummary(id, { summary: { text: 'Short replies', selfReported: [], preferences: ['Short replies'], followUp: [] }, memories: [{ kind: 'preference', text: 'Prefers short replies', sourceSessionIds: [id] }] });
    }
    await test.controller.initialize(); test.controller.updateSettings({ memoryEnabled: true }); await test.controller.startCall();
    const turn = test.controller.sendText('Please remember short replies'); await flush();
    expect(test.api.respond.mock.calls[0][0].memories[0].sourceSessionIds).toEqual(Array.from({ length: 32 }, (_, index) => `source-${index + 1}`));
    expect(test.controller.getSnapshot().memories[0].sourceSessionIds).toHaveLength(33);
    expect((await test.store.read()).memories[0].sourceSessionIds).toHaveLength(33);
    test.playback[0].resolve(); await turn;
  });
});
