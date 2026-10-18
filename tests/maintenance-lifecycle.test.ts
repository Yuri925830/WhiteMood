import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhiteMoodController } from '../src/core/controller';
import { MemoryStore } from '../src/memory/store';

const controllers: WhiteMoodController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function maintenance(operation: 'summary' | 'consolidation') {
  const store = new MemoryStore(`maintenance-lifecycle-${crypto.randomUUID()}`);
  const id = crypto.randomUUID();
  await store.saveSession({ id, language: 'ko', startedAt: 1, endedAt: 2,
    summaryStatus: operation === 'summary' ? 'pending' : 'ready',
    messages: [{ id: 'u1', role: 'user', text: 'I prefer a calm conversation.', timestamp: 1 }],
    ...(operation === 'consolidation' ? { summary: { text: 'Prefers calm conversation.', selfReported: [], preferences: ['Calm conversation'], followUp: [] } } : {}),
  });
  const response = deferred<Response>();
  const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async path => {
    if (path === '/api/health') return Response.json({ configured: true, provider: 'groq', models: { chat: 'test', stt: 'test' } });
    return response.promise; // Deliberately ignores AbortSignal to model late transport completion.
  });
  vi.stubGlobal('fetch', fetchMock);
  const controller = new WhiteMoodController({ store, voices: () => [], speech: { speak: async () => {}, cancel: () => {} } });
  controllers.push(controller); await controller.initialize();
  controller.updateSettings({ memoryEnabled: true });
  const path = operation === 'summary' ? '/api/summarize' : '/api/memory/consolidate';
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === path)).toBe(true));
  const signal = fetchMock.mock.calls.find(([url]) => url === path)![1]!.signal!;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal.aborted).toBe(false);
  return { controller, store, response, dispatchEvent, signal };
}

describe('account lifecycle cancels real maintenance API calls', () => {
  it.each(['summary', 'consolidation'] as const)('ignores a disposed account’s late 401 from %s while the next account remains mounted', async operation => {
    const test = await maintenance(operation);
    test.controller.dispose();
    expect(test.signal.aborted).toBe(true);
    const next = new WhiteMoodController({ store: new MemoryStore(`next-account-${crypto.randomUUID()}`), voices: () => [], speech: { speak: async () => {}, cancel: () => {} } });
    controllers.push(next); await next.initialize();
    test.response.resolve(Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }));
    await vi.waitFor(() => expect(test.controller.getSnapshot().memoryBusy).toBe(false));
    expect(test.dispatchEvent).not.toHaveBeenCalled();
    expect(next.getSnapshot().sessions).toEqual([]);
  });

  it.each(['summary', 'consolidation'] as const)('cancels %s when memory consent is withdrawn', async operation => {
    const test = await maintenance(operation);
    test.controller.updateSettings({ memoryEnabled: false });
    expect(test.signal.aborted).toBe(true);
    test.response.resolve(Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }));
    await vi.waitFor(() => expect(test.controller.getSnapshot().memoryBusy).toBe(false));
    expect(test.dispatchEvent).not.toHaveBeenCalled();
    expect((await test.store.read()).lastConsolidatedAt).toBe(0);
  });

  it.each(['summary', 'consolidation'] as const)('still notifies the currently mounted account when %s genuinely requires login', async operation => {
    const test = await maintenance(operation);
    test.response.resolve(Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }));
    await vi.waitFor(() => expect(test.controller.getSnapshot().memoryBusy).toBe(false));
    expect(test.signal.aborted).toBe(false);
    expect(test.dispatchEvent).toHaveBeenCalledOnce();
    expect(test.dispatchEvent.mock.calls[0][0].type).toBe('whitemood:auth-required');
  });
});
