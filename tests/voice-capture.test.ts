import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrophoneError, VoiceCapture } from '../src/audio/capture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const engines: VoiceCapture[] = [];
function setupCapture(options: { permission?: Promise<MediaStream>; module?: Promise<void>; resume?: Promise<void> } = {}) {
  const order: string[] = [];
  const track = { stop: vi.fn(), onended: null as (() => void) | null, onmute: null as (() => void) | null, onunmute: null as (() => void) | null, label: 'Real selected microphone', muted: false, readyState: 'live' };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const nodes: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  const contexts: FakeContext[] = [];
  const worklets: FakeWorklet[] = [];
  class FakeNode {
    disconnect = vi.fn();
    constructor() { nodes.push(this); }
    connect(node: FakeNode) { return node; }
  }
  class FakeContext {
    state = 'running'; sampleRate = 48000;
    onstatechange: (() => void) | null = null;
    destination = new FakeNode();
    audioWorklet = { addModule: vi.fn(() => options.module ?? Promise.resolve()) };
    resume = vi.fn(() => { order.push('resume'); return options.resume ?? Promise.resolve(); });
    close = vi.fn(async () => { this.state = 'closed'; });
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return new FakeNode(); }
    createBiquadFilter() { return Object.assign(new FakeNode(), { type: '', frequency: { value: 0 } }); }
  }
  class FakeWorklet extends FakeNode {
    port = { onmessage: null as ((event: { data: Float32Array }) => void) | null, close: vi.fn() };
    onprocessorerror: (() => void) | null = null;
    constructor() { super(); worklets.push(this); }
  }
  const getUserMedia = vi.fn(() => { order.push('permission'); return options.permission ?? Promise.resolve(stream); });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  const callbacks = { onUtterance: vi.fn(), onSpeechStart: vi.fn(), onLevel: vi.fn(), onError: vi.fn(), onState: vi.fn() };
  const engine = new VoiceCapture(callbacks); engines.push(engine);
  const frame = (samples = new Float32Array(960)) => worklets[0].port.onmessage?.({ data: samples });
  return { engine, callbacks, getUserMedia, track, stream, contexts, nodes, worklets, order, frame };
}

afterEach(async () => { await Promise.all(engines.splice(0).map(engine => engine.stop())); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('microphone lifetime', () => {
  it('unlocks audio in the click stack, never asks on construction, and releases late permission after stop', async () => {
    const permission = deferred<MediaStream>();
    const setup = setupCapture({ permission: permission.promise });
    expect(setup.getUserMedia).not.toHaveBeenCalled();
    const starting = setup.engine.start();
    expect(setup.order).toEqual(['resume', 'permission']);
    await setup.engine.stop();
    permission.resolve(setup.stream);
    await starting;
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.contexts[0].close).toHaveBeenCalledOnce();
    expect(setup.callbacks.onUtterance).not.toHaveBeenCalled();
  });

  it('closes context and track when stopped while loading the worklet', async () => {
    const module = deferred<void>();
    const setup = setupCapture({ module: module.promise });
    const starting = setup.engine.start();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await setup.engine.stop();
    module.resolve(); await starting;
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.contexts[0].close).toHaveBeenCalledOnce();
    expect(setup.worklets).toHaveLength(0);
  });

  it('cleans the graph, port and tracks before reporting a processor failure', async () => {
    const setup = setupCapture();
    await setup.engine.start();
    setup.worklets[0].onprocessorerror?.();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.contexts[0].close).toHaveBeenCalledOnce();
    expect(setup.worklets[0].port.close).toHaveBeenCalledOnce();
    expect(setup.worklets[0].disconnect).toHaveBeenCalledOnce();
    expect(setup.callbacks.onError).toHaveBeenCalledOnce();
    expect(setup.callbacks.onUtterance).not.toHaveBeenCalled();
  });

  it('does not claim ready just because permission was granted; actual PCM drives the meter', async () => {
    const setup = setupCapture(); await setup.engine.start();
    expect(setup.callbacks.onState.mock.calls.map(([state]) => state.status)).toEqual(['starting']);
    setup.frame(Float32Array.from({ length: 960 }, (_, i) => 0.006 * Math.sin(2 * Math.PI * 180 * i / 48000)));
    expect(setup.callbacks.onState).toHaveBeenLastCalledWith({ status: 'ready', deviceLabel: 'Real selected microphone' });
    expect(setup.callbacks.onLevel.mock.calls.at(-1)?.[0]).toBeGreaterThan(0.1);
  });

  it('reports a silent processor and releases tracks instead of listening forever', async () => {
    vi.useFakeTimers();
    const setup = setupCapture(); await setup.engine.start();
    await vi.advanceTimersByTimeAsync(4500);
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.contexts[0].close).toHaveBeenCalledOnce();
    expect(setup.callbacks.onError).toHaveBeenCalledWith(new MicrophoneError('microphone_stalled'));
  });

  it('distinguishes delivered zero PCM from a stalled processor without uploading silence', async () => {
    vi.useFakeTimers();
    const setup = setupCapture(); await setup.engine.start();
    for (let i = 0; i < 14; i++) { setup.frame(); await vi.advanceTimersByTimeAsync(500); }
    expect(setup.callbacks.onState).toHaveBeenLastCalledWith({ status: 'quiet', deviceLabel: 'Real selected microphone' });
    expect(setup.callbacks.onError).not.toHaveBeenCalled();
    expect(setup.callbacks.onUtterance).not.toHaveBeenCalled();
  });

  it.each(['track', 'context'])('releases input after a persistent %s interruption and detaches lifecycle callbacks', async kind => {
    vi.useFakeTimers();
    const setup = setupCapture(); await setup.engine.start();
    if (kind === 'track') { setup.track.muted = true; setup.track.onmute?.(); }
    else { setup.contexts[0].state = 'suspended'; setup.contexts[0].onstatechange?.(); }
    expect(setup.callbacks.onState).toHaveBeenLastCalledWith({ status: 'interrupted', deviceLabel: 'Real selected microphone' });
    await vi.advanceTimersByTimeAsync(4500);
    expect(setup.callbacks.onError).toHaveBeenCalledWith(new MicrophoneError('microphone_interrupted'));
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.track.onmute).toBe(null);
    expect(setup.contexts[0].onstatechange).toBe(null);
  });

  it('does not wait forever for an audio context blocked by the browser', async () => {
    vi.useFakeTimers(); const resumed = deferred<void>();
    const setup = setupCapture({ resume: resumed.promise });
    const starting = setup.engine.start();
    const rejected = expect(starting).rejects.toMatchObject({ code: 'microphone_interrupted' });
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.contexts[0].close).toHaveBeenCalledOnce();
  });
});
