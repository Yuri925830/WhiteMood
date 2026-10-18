import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createAccountController } from '../src/core/accountController';
import { MemoryStore } from '../src/memory/store';
import type { WhiteMoodController } from '../src/core/controller';

const controllers: WhiteMoodController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.unstubAllGlobals(); });

it('keeps call records and memory consent separate when the browser changes accounts', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ configured: false, provider: 'groq', models: { chat: 'test', stt: 'test' } })));
  const aliceId = crypto.randomUUID(), bobId = crypto.randomUUID();
  const store = new MemoryStore(`whitemood-memory-v1:${aliceId}`);
  await store.saveSession({ id: 'alice-call', language: 'ko', startedAt: 1, endedAt: 2, summaryStatus: 'none', messages: [] });
  const alice = createAccountController(aliceId); controllers.push(alice); await alice.initialize();
  alice.updateSettings({ language: 'ko', memoryEnabled: true });
  expect(alice.getSnapshot().sessions.map(session => session.id)).toEqual(['alice-call']);
  alice.dispose();
  const bob = createAccountController(bobId); controllers.push(bob); await bob.initialize();
  expect(bob.getSnapshot().sessions).toEqual([]);
  expect(bob.getSnapshot().settings.memoryEnabled).toBe(false);
  expect(bob.getSnapshot().settings.language).toBe('zh');
  const aliceAgain = createAccountController(aliceId); controllers.push(aliceAgain); await aliceAgain.initialize();
  expect(aliceAgain.getSnapshot().sessions[0]?.id).toBe('alice-call');
  expect(aliceAgain.getSnapshot().settings).toMatchObject({ language: 'ko', memoryEnabled: true });
});
