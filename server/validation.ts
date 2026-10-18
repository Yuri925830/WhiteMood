import type {
  ChatMessage, ConsolidateRequest, CvObservation, Language, MemoryCandidate,
  MemoryItem, RespondRequest, RespondResult, SessionSummary, SummarizeRequest,
  SummarizeResult, VoiceSignals,
} from '../shared/types';

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) {
    super(message);
  }
}

type Obj = Record<string, unknown>;
const bad = (): never => { throw new ApiFailure(400, 'INVALID_REQUEST', 'The request contains invalid or excessive data.'); };
export const object = (value: unknown): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  return value as Obj;
};
function keys(value: Obj, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) bad();
}
export function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) return bad();
  return value.trim();
}
function array<T>(value: unknown, max: number, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return bad();
  return value.map(parse);
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bad();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return bad();
  return value;
}
const clamp = (value: unknown, min: number, max: number) => Math.min(max, Math.max(min, finite(value)));
export function language(value: unknown): Language {
  if (value !== 'zh' && value !== 'en' && value !== 'ko') return bad();
  return value;
}
function id(value: unknown): string {
  const result = string(value, 128);
  if (!/^[\p{L}\p{N}_.:-]+$/u.test(result)) return bad();
  return result;
}
function timestamp(value: unknown): number {
  const result = finite(value);
  if (result < 0 || result > 8_640_000_000_000_000) return bad();
  return result;
}
function strings(value: unknown, max = 12, length = 1200): string[] {
  return array(value, max, item => string(item, length));
}
function sourceIds(value: unknown): string[] {
  const result = array(value, 32, id);
  if (!result.length || new Set(result).size !== result.length) return bad();
  return result;
}

function message(value: unknown): ChatMessage {
  const item = object(value);
  keys(item, ['id', 'role', 'text', 'timestamp', 'spokenText', 'interrupted']);
  if (item.role !== 'user' && item.role !== 'assistant') return bad();
  const result: ChatMessage = {
    id: id(item.id), role: item.role, text: string(item.text, 6000, true), timestamp: timestamp(item.timestamp),
  };
  if (item.spokenText !== undefined) result.spokenText = string(item.spokenText, 6000, true);
  if (item.interrupted !== undefined) result.interrupted = bool(item.interrupted);
  return result;
}
function messages(value: unknown): ChatMessage[] {
  const result = array(value, 80, message);
  if (result.reduce((size, msg) => size + msg.text.length + (msg.spokenText?.length ?? 0), 0) > 48_000) return bad();
  return result;
}
function memory(value: unknown): MemoryItem {
  const item = object(value);
  keys(item, ['id', 'kind', 'text', 'sourceSessionIds', 'createdAt', 'updatedAt']);
  return {
    id: id(item.id), ...candidate(item), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt),
  };
}
function candidate(value: unknown): MemoryCandidate {
  const item = object(value);
  if (item.kind !== 'preference' && item.kind !== 'event' && item.kind !== 'self_report') return bad();
  return { kind: item.kind, text: string(item.text, 1200), sourceSessionIds: sourceIds(item.sourceSessionIds) };
}
function voice(value: unknown): VoiceSignals {
  const item = object(value);
  keys(item, ['durationMs', 'voicedRatio', 'meanEnergy', 'peakEnergy']);
  return {
    durationMs: clamp(item.durationMs, 0, 120_000), voicedRatio: clamp(item.voicedRatio, 0, 1),
    meanEnergy: clamp(item.meanEnergy, 0, 1), peakEnergy: clamp(item.peakEnergy, 0, 1),
  };
}
function cv(value: unknown): CvObservation {
  const item = object(value);
  keys(item, ['source', 'capturedAt', 'quality', 'features']);
  if (item.source !== 'face') return bad();
  const entries = Object.entries(object(item.features));
  if (entries.length > 64 || entries.some(([key]) => !/^[a-zA-Z0-9_.:-]{1,64}$/.test(key))) return bad();
  return {
    source: 'face', capturedAt: timestamp(item.capturedAt), quality: clamp(item.quality, 0, 1),
    features: Object.fromEntries(entries.map(([key, value]) => [key, clamp(value, -100, 100)])),
  };
}

export function parseRespond(value: unknown): RespondRequest {
  const item = object(value);
  keys(item, ['language', 'text', 'history', 'memories', 'voice', 'cv']);
  return {
    language: language(item.language), text: string(item.text, 6000), history: messages(item.history),
    memories: array(item.memories, 40, memory),
    ...(item.voice !== undefined ? { voice: voice(item.voice) } : {}),
    ...(item.cv !== undefined ? { cv: cv(item.cv) } : {}),
  };
}
export function parseSummarize(value: unknown): SummarizeRequest {
  const item = object(value);
  keys(item, ['language', 'sessionId', 'messages']);
  const result = { language: language(item.language), sessionId: id(item.sessionId), messages: messages(item.messages) };
  if (!result.messages.some(msg => msg.role === 'user' && msg.text.trim())) return bad();
  return result;
}
export function parseSummary(value: unknown): SessionSummary {
  const item = object(value);
  keys(item, ['text', 'selfReported', 'preferences', 'followUp']);
  return {
    text: string(item.text, 4000), selfReported: strings(item.selfReported),
    preferences: strings(item.preferences), followUp: strings(item.followUp),
  };
}
export function parseConsolidate(value: unknown): ConsolidateRequest {
  const item = object(value);
  keys(item, ['language', 'summaries', 'existing']);
  const summaries = array(item.summaries, 30, value => {
    const row = object(value);
    keys(row, ['id', 'endedAt', 'summary']);
    return { id: id(row.id), endedAt: timestamp(row.endedAt), summary: parseSummary(row.summary) };
  });
  if (!summaries.length || new Set(summaries.map(s => s.id)).size !== summaries.length) return bad();
  const existing = array(item.existing, 80, memory);
  // Existing memories must point to sessions supplied by this caller; no orphaned sources may propagate.
  const validIds = new Set(summaries.map(s => s.id));
  if (existing.some(mem => mem.sourceSessionIds.some(source => !validIds.has(source)))) return bad();
  return { language: language(item.language), summaries, existing };
}

export function parseRespondResult(value: unknown): RespondResult {
  const item = object(value);
  keys(item, ['reply', 'speech', 'reflection']);
  const speech = object(item.speech);
  keys(speech, ['style', 'rate', 'pitch', 'pauseMs']);
  if (speech.style !== 'warm' && speech.style !== 'steady' && speech.style !== 'clear') return bad();
  const reflection = object(item.reflection);
  keys(reflection, ['feeling', 'evidence', 'uncertain']);
  return {
    reply: string(item.reply, 3000),
    speech: { style: speech.style, rate: clamp(speech.rate, 0.75, 1.15), pitch: clamp(speech.pitch, 0.8, 1.2), pauseMs: Math.round(clamp(speech.pauseMs, 150, 900)) },
    reflection: { feeling: string(reflection.feeling, 300), evidence: strings(reflection.evidence, 4, 500), uncertain: bool(reflection.uncertain) },
  };
}
export function parseCandidates(value: unknown, validIds: Set<string>): MemoryCandidate[] {
  return array(value, 40, value => {
    const item = object(value);
    keys(item, ['kind', 'text', 'sourceSessionIds']);
    const result = candidate(item);
    if (result.sourceSessionIds.some(source => !validIds.has(source))) return bad();
    return result;
  });
}
export function parseSummarizeResult(value: unknown, sessionId: string): SummarizeResult {
  const item = object(value);
  keys(item, ['summary', 'memories']);
  return { summary: parseSummary(item.summary), memories: parseCandidates(item.memories, new Set([sessionId])) };
}

/** Generated but unspoken assistant words never become conversation evidence. */
export function heardMessages(input: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return input.flatMap(message => {
    const content = message.role === 'assistant' ? message.spokenText?.trim() : message.text.trim();
    return content ? [{ role: message.role, content }] : [];
  });
}
