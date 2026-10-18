import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceCapture } from '../src/audio/capture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function setupCapture(options: { permission?: Promise<MediaStream>; module?: Promise<void> } = {}) {
  const track = { stop: vi.fn(), onended: null };
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
    destination = new FakeNode();
    audioWorklet = { addModule: vi.fn(() => options.module ?? Promise.resolve()) };
    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => { this.state = 'closed'; });
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return new FakeNode(); }
    createBiquadFilter() { return Object.assign(new FakeNode(), { type: '', frequency: { value: 0 } }); }
  }
  class FakeWorklet extends FakeNode {
    port = { onmessage: null, close: vi.fn() };
    onprocessorerror: (() => void) | null = null;
    constructor() { super(); worklets.push(this); }
  }
  const getUserMedia = vi.fn(() => options.permission ?? Promise.resolve(stream));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  const callbacks = { onUtterance: vi.fn(), onSpeechStart: vi.fn(), onLevel: vi.fn(), onError: vi.fn() };
  return { engine: new VoiceCapture(callbacks), callbacks, getUserMedia, track, stream, contexts, nodes, worklets };
}

afterEach(() => vi.unstubAllGlobals());

describe('microphone lifetime', () => {
  it('never asks for permission on construction, and releases a late permission result after stop', async () => {
    const permission = deferred<MediaStream>();
    const setup = setupCapture({ permission: permission.promise });
    expect(setup.getUserMedia).not.toHaveBeenCalled();
    const starting = setup.engine.start();
    await setup.engine.stop();
    permission.resolve(setup.stream);
    await starting;
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(setup.contexts).toHaveLength(0);
    expect(setup.callbacks.onUtterance).not.toHaveBeenCalled();
  });

  it('closes context and track when stopped while loading the worklet', async () => {
    const module = deferred<void>();
    const setup = setupCapture({ module: module.promise });
    const starting = setup.engine.start();
    await Promise.resolve(); await Promise.resolve();
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
});
