import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { MemoryItem, SessionRecord, SessionSummary } from '../shared/types';
import { buildConsolidationBatch, DEFAULT_MEMORY_REQUEST_BYTES } from '../src/core/memoryBudget';
import { MemoryStore, type MemorySnapshot } from '../src/memory/store';
import { parseConsolidate } from '../server/validation';

const summary = (text = '用户说希望简短回应。'): SessionSummary => ({ text, selfReported: [], preferences: [text], followUp: [] });
const session = (id: string, endedAt: number, value = summary()): SessionRecord => ({ id, language: 'zh', startedAt: 1, endedAt, messages: [], summary: value, summaryStatus: 'ready' });
const memory = (id: string, sourceSessionIds: string[], text = '用户希望简短回应。'): MemoryItem => ({ id, kind: 'preference', text, sourceSessionIds, createdAt: 1, updatedAt: 2 });
const snapshot = (sessions: SessionRecord[] = [], memories: MemoryItem[] = []): MemorySnapshot => ({ sessions, memories, deletedSessionIds: [], excludedSourceIds: [], blockedTexts: [], lastConsolidatedAt: 0, revision: 1 });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('bounded real-record consolidation batches', () => {
  it('limits the complete UTF-8 request, including Korean/Chinese/emoji and JSON overhead', () => {
    const long = summary('用户说今天有点疲惫。 한국어 대화를 원해요. 🌿'.repeat(300));
    long.selfReported = Array.from({ length: 20 }, (_, i) => `${i} 用户自己说心情和精力有所变化。`.repeat(30));
    long.preferences = Array(20).fill('응답을 짧게 해 주세요.'.repeat(50));
    long.followUp = Array(20).fill('下次继续聊学校和发表。'.repeat(50));
    const source = snapshot(Array.from({ length: 30 }, (_, i) => session(`s${i}`, i + 2, long)));
    const original = structuredClone(source);
    const batch = buildConsolidationBatch(source, 'ko');
    expect(batch).not.toBeNull();
    expect(bytes(batch!.request)).toBe(batch!.byteLength);
    expect(batch!.byteLength).toBeLessThanOrEqual(DEFAULT_MEMORY_REQUEST_BYTES);
    expect(batch!.sourceIds[0]).toBe('s29');
    expect(() => parseConsolidate(batch!.request)).not.toThrow();
    expect(source).toEqual(original);
  });

  it('includes only current ready source summaries and complete valid provenance', () => {
    const source = snapshot([session('recent', 100), session('old', 2), session('deleted', 90), session('excluded', 80), { ...session('pending', 70), summaryStatus: 'pending' }], [
      memory('valid', ['recent']), memory('orphan', ['missing']), memory('partly-excluded', ['recent', 'excluded']), memory('unavailable', ['pending']),
    ]);
    source.deletedSessionIds = ['deleted']; source.excludedSourceIds = ['excluded'];
    const batch = buildConsolidationBatch(source, 'zh')!;
    expect(batch.sourceIds).toEqual(['recent', 'old']);
    expect(batch.includedMemoryIds).toEqual(['valid']);
    expect(batch.request.existing[0].sourceSessionIds).toEqual(['recent']);
    expect(() => parseConsolidate(batch.request)).not.toThrow();
  });

  it('does not truncate memory facts to fit a budget; unsubmitted IDs stay outside replacement scope', () => {
    const source = snapshot([session('s1', 10)], [
      memory('small', ['s1'], '用户希望用韩语。'), memory('large', ['s1'], '用户自己描述的信息'.repeat(120)),
    ]);
    const batch = buildConsolidationBatch(source, 'zh', { maxBytes: 900 })!;
    expect(batch.byteLength).toBeLessThanOrEqual(900);
    expect(batch.includedMemoryIds).toContain('small'); expect(batch.includedMemoryIds).not.toContain('large');
    expect(batch.request.existing[0].text).toBe('用户希望用韩语。');
    expect(() => parseConsolidate(batch.request)).not.toThrow();
  });

  it('skips malformed/oversized legacy memory records so they cannot cause permanent validation failures', () => {
    const sources = Array.from({ length: 35 }, (_, i) => session(`s${i}`, i + 1));
    const source = snapshot(sources, [
      memory('over-provenance-limit', sources.map(s => s.id)),
      memory('oversized', ['s34'], 'x'.repeat(1201)),
      { ...memory('wrong-time', ['s34']), updatedAt: NaN },
      memory('good', ['s34']),
    ]);
    const batch = buildConsolidationBatch(source, 'en')!;
    expect(batch.includedMemoryIds).toEqual(['good']);
    expect(() => parseConsolidate(batch.request)).not.toThrow();
  });

  it('returns no work for an empty/excluded history and rejects nonsensical budgets', () => {
    expect(buildConsolidationBatch(snapshot(), 'zh')).toBeNull();
    const excluded = snapshot([session('s1', 10)]); excluded.excludedSourceIds = ['s1'];
    expect(buildConsolidationBatch(excluded, 'zh')).toBeNull();
    expect(() => buildConsolidationBatch(snapshot(), 'zh', { maxBytes: 20_000 })).toThrow(RangeError);
    expect(() => buildConsolidationBatch(snapshot(), 'zh', { maxSummaries: 31 })).toThrow(RangeError);
  });

  it('preserves all same-source memories omitted from the request while replacing only submitted IDs', async () => {
    const store = new MemoryStore(`budget-store-${crypto.randomUUID()}`);
    await store.saveSession({ ...session('s1', 10), summaryStatus: 'pending' });
    await store.commitSummary('s1', { summary: summary(), memories: [
      { kind: 'preference', text: '用户希望简短回应。', sourceSessionIds: ['s1'] },
      { kind: 'event', text: '用户说下周有学校发表。', sourceSessionIds: ['s1'] },
    ] });
    const before = await store.read();
    const provided = before.memories.find(m => m.kind === 'preference')!;
    const omitted = before.memories.find(m => m.kind === 'event')!;
    expect(await store.applyConsolidation(before.revision, { memories: [
      { kind: 'preference', text: '用户偏好简短回答。', sourceSessionIds: ['s1'] },
      { kind: 'event', text: '不合法来源的新断言。', sourceSessionIds: ['unknown'] },
    ] }, ['s1'], [provided.id])).toBe(true);
    const after = await store.read();
    expect(after.memories.find(m => m.id === omitted.id)).toEqual(omitted);
    expect(after.memories.some(m => m.id === provided.id)).toBe(false);
    expect(after.memories.map(m => m.text)).toContain('用户偏好简短回答。');
    expect(after.memories.some(m => m.sourceSessionIds.includes('unknown'))).toBe(false);
  });
});
