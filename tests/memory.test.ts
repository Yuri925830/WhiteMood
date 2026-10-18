import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { MemoryItem, SessionRecord, SummarizeResult } from '../shared/types';
import { MemoryStore, selectMemories } from '../src/memory/store';

const createStore = () => new MemoryStore(`memory-test-${crypto.randomUUID()}`);
const session = (id = 'session-1'): SessionRecord => ({
  id, language: 'zh', startedAt: 1, endedAt: 20, summaryStatus: 'pending',
  messages: [{ id: 'message-1', role: 'user', text: '请回答简短些。', timestamp: 2 }],
});
const result = (id = 'session-1', text = '用户希望回答简短。'): SummarizeResult => ({
  summary: { text, selfReported: [], preferences: [text], followUp: [] },
  memories: [{ kind: 'preference', text, sourceSessionIds: [id] }],
});
async function remembered() {
  const store = createStore();
  await store.saveSession(session()); await store.commitSummary('session-1', result());
  return store;
}

describe('device-local memory provenance and deletion', () => {
  it('persists actual session data and source-attributed summary memories across store instances', async () => {
    const name = `memory-persist-${crypto.randomUUID()}`;
    const store = new MemoryStore(name);
    await store.saveSession(session());
    expect(await store.commitSummary('session-1', result())).toBe(true);
    const state = await new MemoryStore(name).read();
    expect(state.sessions[0].summaryStatus).toBe('ready');
    expect(state.sessions[0].summary).toEqual(result().summary);
    expect(state.memories[0].sourceSessionIds).toEqual(['session-1']);
    expect(state.memories[0].text).toBe(result().memories[0].text);
    expect(state.revision).toBeGreaterThan(0);
  });

  it('does not invent an empty session or summary when no stored user conversation exists', async () => {
    const store = createStore();
    expect((await store.read()).sessions).toEqual([]);
    expect(await store.commitSummary('missing', result('missing'))).toBe(false);
    expect((await store.read()).memories).toEqual([]);
  });

  it('refuses late summaries and late saves after deleting a session', async () => {
    const store = createStore(); await store.saveSession(session());
    await store.deleteSession('session-1');
    expect(await store.commitSummary('session-1', result())).toBe(false);
    expect(await store.saveSession(session())).toBe(false);
    const state = await store.read();
    expect(state.sessions).toEqual([]); expect(state.memories).toEqual([]);
    expect(state.deletedSessionIds).toContain('session-1');
  });

  it('removes every memory touching a deleted source and leaves unrelated records usable', async () => {
    const store = await remembered();
    await store.saveSession(session('session-2')); await store.commitSummary('session-2', result('session-2'));
    await store.saveSession(session('session-3')); await store.commitSummary('session-3', result('session-3', '用户希望用韩语交流。'));
    expect((await store.read()).memories.find(m => m.sourceSessionIds.includes('session-1'))?.sourceSessionIds).toEqual(['session-1', 'session-2']);
    await store.deleteSession('session-1');
    const state = await store.read();
    expect(state.memories).toHaveLength(1);
    expect(state.memories[0].sourceSessionIds).toEqual(['session-3']);
    expect(state.sessions.map(s => s.id)).toEqual(['session-2', 'session-3']);
  });

  it('rejects stale consolidation after any newer save or deletion', async () => {
    const store = await remembered(); const stale = await store.read();
    await store.deleteMemory(stale.memories[0].id);
    expect(await store.applyConsolidation(stale.revision, { memories: result().memories })).toBe(false);
    expect((await store.read()).memories).toEqual([]);
    const current = await store.read(); await store.saveSession(session('session-new'));
    expect(await store.applyConsolidation(current.revision, { memories: result().memories })).toBe(false);
  });

  it('blocks exact normalized deleted text even if a new source suggests it again', async () => {
    const store = await remembered(); const first = await store.read();
    await store.deleteMemory(first.memories[0].id);
    await store.saveSession(session('session-2'));
    await store.commitSummary('session-2', result('session-2', '  用户希望回答简短。  '));
    expect((await store.read()).memories).toEqual([]);
  });

  it('keeps only valid source session IDs during summary merge', async () => {
    const store = createStore(); await store.saveSession(session());
    const sourceResult = result(); sourceResult.memories[0].sourceSessionIds = ['session-1', 'missing', 'session-1'];
    await store.commitSummary('session-1', sourceResult);
    expect((await store.read()).memories[0].sourceSessionIds).toEqual(['session-1']);
  });

  it('clears records and prevents in-flight saves, summaries and consolidations restoring them', async () => {
    const store = await remembered(); await store.saveSession(session('pending-session'));
    const old = await store.read(); await store.clear();
    expect(await store.saveSession(session())).toBe(false);
    expect(await store.commitSummary('pending-session', result('pending-session'))).toBe(false);
    expect(await store.applyConsolidation(old.revision, { memories: result().memories })).toBe(false);
    const cleared = await store.read();
    expect(cleared.sessions).toEqual([]); expect(cleared.memories).toEqual([]); expect(cleared.lastConsolidatedAt).toBe(0);
  });

  it('makes user edits durable and prevents exact old text being re-added', async () => {
    const store = await remembered(); const before = await store.read();
    await store.editMemory(before.memories[0].id, '用户希望详细解释。');
    const edited = await store.read();
    expect(edited.memories[0].text).toBe('用户希望详细解释。');
    expect(edited.memories[0].sourceSessionIds).toEqual(['session-1']);
    expect(edited.revision).toBeGreaterThan(before.revision);
    expect(await store.applyConsolidation(edited.revision, { memories: result().memories })).toBe(true);
    expect((await store.read()).memories.map(m => m.text)).toEqual(['用户希望详细解释。']);
  });

  it('does not resurrect a deleted fact by paraphrasing an old source summary', async () => {
    const store = await remembered(); const before = await store.read();
    await store.deleteMemory(before.memories[0].id);
    const afterDeletion = await store.read();
    await store.applyConsolidation(afterDeletion.revision, {
      memories: [{ kind: 'preference', text: '用户偏好短而精练的回复。', sourceSessionIds: ['session-1'] }],
    });
    expect((await store.read()).memories).toEqual([]);
  });

  it('does not reintroduce an old paraphrased preference after a manual correction', async () => {
    const store = await remembered(); const before = await store.read();
    await store.editMemory(before.memories[0].id, '用户希望详细解释。');
    const edited = await store.read();
    await store.applyConsolidation(edited.revision, {
      memories: [{ kind: 'preference', text: '用户偏好短而精练的回复。', sourceSessionIds: ['session-1'] }],
    });
    expect((await store.read()).memories.map(m => m.text)).toEqual(['用户希望详细解释。']);
  });

  it('applies a consolidated replacement so superseded facts do not accumulate forever', async () => {
    const store = await remembered();
    await store.saveSession(session('session-2'));
    await store.commitSummary('session-2', result('session-2', '用户现在希望详细解释。'));
    const before = await store.read();
    expect(before.memories).toHaveLength(2);
    await store.applyConsolidation(before.revision, { memories: [{ kind: 'preference', text: '用户现在希望详细解释。', sourceSessionIds: ['session-2'] }] });
    expect((await store.read()).memories.map(m => m.text)).toEqual(['用户现在希望详细解释。']);
  });

  it('preserves memories outside a consolidation window and rejects candidate sources outside it', async () => {
    const store = await remembered();
    await store.saveSession(session('session-2')); await store.commitSummary('session-2', result('session-2', '用户希望用韩语交流。'));
    const before = await store.read();
    await store.applyConsolidation(before.revision, { memories: [
      { kind: 'preference', text: '用户希望简短作答。', sourceSessionIds: ['session-1'] },
      { kind: 'event', text: '不在本次整合来源中的新断言。', sourceSessionIds: ['session-2'] },
    ] }, ['session-1']);
    const after = await store.read();
    expect(after.memories.map(m => m.text).sort()).toEqual(['用户希望简短作答。', '用户希望用韩语交流。'].sort());
  });
});

describe('relevant memory selection', () => {
  it('ranks CJK/English topic matches with stable communication preferences and caps context', () => {
    const memory = (index: number, text: string, kind: MemoryItem['kind'] = 'event'): MemoryItem => ({
      id: `memory-${index}`, kind, text, sourceSessionIds: ['s1'], createdAt: index, updatedAt: index,
    });
    const values = [
      memory(0, '用户希望回应简短。', 'preference'), memory(1, '用户提到学校发表。'),
      memory(2, 'The user has an English presentation.'), ...Array.from({ length: 12 }, (_, index) => memory(index + 3, `Unrelated topic ${index}`)),
    ];
    expect(selectMemories(values, '学校发表').map(m => m.id).slice(0, 2)).toEqual(['memory-1', 'memory-0']);
    expect(selectMemories(values, 'English presentation')[0].id).toBe('memory-2');
    expect(selectMemories(values, '학교 발표')).toHaveLength(8);
    expect(values[0].id).toBe('memory-0');
  });
});
