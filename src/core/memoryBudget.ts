import type { ConsolidateRequest, Language, MemoryItem, SessionSummary } from '../../shared/types';
import type { MemorySnapshot } from '../memory/store';

/** A conservative payload boundary, not an exact tokenizer or an API quota guarantee. */
export const DEFAULT_MEMORY_REQUEST_BYTES = 4000;
export const MAX_MEMORY_REQUEST_BYTES = 6000;

export interface ConsolidationBatch {
  request: ConsolidateRequest;
  /** Only these summaries were actually provided to the model. */
  sourceIds: string[];
  /** Other existing memories must survive this batch, even when they share a source. */
  includedMemoryIds: string[];
  byteLength: number;
}
export interface MemoryBudgetOptions {
  maxBytes?: number;
  maxSummaries?: number;
}

const encoder = new TextEncoder();
const size = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\p{L}\p{N}_.:-]+$/u.test(value);
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;

function shorten(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  // Keep complete Unicode scalars; the ellipsis explicitly marks an omitted suffix.
  let end = maxLength - 1;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(trimmed[end - 1])) end--;
  const prefix = trimmed.slice(0, end);
  const punctuation = Math.max(...['。', '！', '？', '.', '!', '?', ';', '；', '\n'].map(mark => prefix.lastIndexOf(mark)));
  return (punctuation >= prefix.length / 2 ? prefix.slice(0, punctuation + 1) : prefix.trimEnd()) + '…';
}

function compactList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => shorten(item, 160)))].slice(0, 4);
}

function compactSummary(input: SessionSummary, byteBudget: number): SessionSummary | null {
  const summary: SessionSummary = {
    text: typeof input.text === 'string' ? shorten(input.text, 600) : '',
    selfReported: compactList(input.selfReported), preferences: compactList(input.preferences), followUp: compactList(input.followUp),
  };
  if (!summary.text) summary.text = summary.selfReported[0] || summary.preferences[0] || summary.followUp[0] || '';
  if (!summary.text) return null;
  // Repeatedly shorten the largest field; never synthesize a psychological conclusion.
  while (size(summary) > byteBudget) {
    const fields: Array<{ text: string; set: (value: string) => void }> = [
      { text: summary.text, set: value => { summary.text = value; } },
      ...(['selfReported', 'preferences', 'followUp'] as const).flatMap(key => summary[key].map((text, index) => ({ text, set: (value: string) => { summary[key][index] = value; } }))),
    ];
    const largest = fields.sort((a, b) => size(b.text) - size(a.text))[0];
    if (largest.text.length > 32) { largest.set(shorten(largest.text, Math.max(32, Math.floor(largest.text.length * 0.7)))); continue; }
    if (summary.followUp.length) summary.followUp.pop();
    else if (summary.preferences.length) summary.preferences.pop();
    else if (summary.selfReported.length) summary.selfReported.pop();
    else return null;
  }
  return summary;
}

function usableMemory(item: MemoryItem, scope: Set<string>): boolean {
  return validId(item.id) && ['preference', 'event', 'self_report'].includes(item.kind)
    && typeof item.text === 'string' && Boolean(item.text.trim()) && item.text.length <= 1200
    && finiteTime(item.createdAt) && finiteTime(item.updatedAt)
    && Array.isArray(item.sourceSessionIds) && item.sourceSessionIds.length > 0 && item.sourceSessionIds.length <= 32
    && new Set(item.sourceSessionIds).size === item.sourceSessionIds.length
    && item.sourceSessionIds.every(id => validId(id) && scope.has(id));
}

/**
 * Build one small, valid consolidation request from actual local records.
 * UTF-8 byte accounting also constrains CJK/emoji payloads that a character-only cap misses.
 * Summaries may be explicitly abbreviated; existing memory records are included whole or omitted.
 * Pass BOTH returned ID arrays to MemoryStore.applyConsolidation so omitted facts remain stored.
 */
export function buildConsolidationBatch(snapshot: MemorySnapshot, language: Language, options: MemoryBudgetOptions = {}): ConsolidationBatch | null {
  const maxBytes = options.maxBytes ?? DEFAULT_MEMORY_REQUEST_BYTES;
  const maxSummaries = options.maxSummaries ?? 8;
  if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > MAX_MEMORY_REQUEST_BYTES) throw new RangeError('Memory payload budget must be 512–6000 bytes.');
  if (!Number.isInteger(maxSummaries) || maxSummaries < 1 || maxSummaries > 30) throw new RangeError('Memory summary count must be 1–30.');
  const excluded = new Set([...snapshot.deletedSessionIds, ...(snapshot.excludedSourceIds ?? [])]);
  const sessions = snapshot.sessions.filter(item => validId(item.id) && item.summaryStatus === 'ready' && item.summary && finiteTime(item.endedAt) && !excluded.has(item.id))
    .sort((a, b) => b.endedAt! - a.endedAt!);
  if (!sessions.length) return null;
  const request: ConsolidateRequest = { language, summaries: [], existing: [] };
  // Reserve room for existing facts; a large summary must not consume the entire request.
  const summaryBudget = Math.floor(maxBytes * 0.65);
  const perSummaryBudget = Math.max(192, Math.floor(summaryBudget / Math.min(3, sessions.length)) - 100);
  const seen = new Set<string>();
  for (const session of sessions) {
    if (request.summaries.length >= maxSummaries) break;
    if (seen.has(session.id)) continue;
    const summary = compactSummary(session.summary!, perSummaryBudget);
    if (!summary) continue;
    const entry = { id: session.id, endedAt: session.endedAt!, summary };
    const next = { ...request, summaries: [...request.summaries, entry] };
    if (size(next) > summaryBudget) continue;
    request.summaries.push(entry); seen.add(session.id);
  }
  if (!request.summaries.length) return null;
  const sourceIds = request.summaries.map(item => item.id);
  const scope = new Set(sourceIds);
  const seenMemories = new Set<string>();
  const existing = snapshot.memories.filter(item => usableMemory(item, scope)).sort((a, b) => {
    const preferencePriority = Number(b.kind === 'preference') - Number(a.kind === 'preference');
    return preferencePriority || b.updatedAt - a.updatedAt;
  });
  for (const item of existing) {
    if (request.existing.length >= 80) break;
    if (seenMemories.has(item.id)) continue;
    const record: MemoryItem = { id: item.id, kind: item.kind, text: item.text, sourceSessionIds: [...item.sourceSessionIds], createdAt: item.createdAt, updatedAt: item.updatedAt };
    if (size({ ...request, existing: [...request.existing, record] }) > maxBytes) continue;
    request.existing.push(record); seenMemories.add(item.id);
  }
  return { request, sourceIds, includedMemoryIds: request.existing.map(item => item.id), byteLength: size(request) };
}
