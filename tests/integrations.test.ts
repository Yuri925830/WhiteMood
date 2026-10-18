import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, CvObservation } from '../shared/types';
import { forgetCurrentCall, heardHistory, summaryChunks } from '../src/core/history';
import { getCvAdapter, recentCvObservation, registerCvAdapter, subscribeCvAdapter } from '../src/integrations/cv';

const now = 100_000;
const observation = (extra: Partial<CvObservation> = {}): CvObservation => ({ source: 'face', capturedAt: now, quality: 0.8, features: { mouthSmileLeft: 0.4 }, ...extra });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });

describe('CV integration seam, not a camera implementation', () => {
  it('starts with no adapter and never invents an observation', () => {
    expect(getCvAdapter()).toBeNull(); expect(recentCvObservation(null, now)).toBeUndefined();
  });

  it('registers one owner adapter, notifies subscribers and releases it on removal', () => {
    const listener = vi.fn(); cleanups.push(subscribeCvAdapter(listener));
    const adapter = { start: vi.fn(async () => undefined), stop: vi.fn() };
    const unregister = registerCvAdapter(adapter); cleanups.push(unregister);
    expect(getCvAdapter()).toBe(adapter); expect(listener).toHaveBeenCalledTimes(1);
    expect(adapter.start).not.toHaveBeenCalled();
    expect(() => registerCvAdapter({ start: vi.fn(), stop: vi.fn() })).toThrow();
    unregister(); expect(getCvAdapter()).toBeNull(); expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    unregister(); expect(adapter.stop).toHaveBeenCalledTimes(1);
  });

  it('rejects stale, far-future and low-quality observations rather than interpreting missing CV', () => {
    for (const value of [observation({ capturedAt: now - 10_001 }), observation({ capturedAt: now + 1001 }), observation({ quality: 0.49 }), observation({ quality: 1.01 }), observation({ capturedAt: Number.NaN })]) {
      expect(recentCvObservation(value, now)).toBeUndefined();
    }
    expect(recentCvObservation(observation({ capturedAt: now - 10_000 }), now)).toBeDefined();
    expect(recentCvObservation(observation({ capturedAt: now + 1000 }), now)).toBeDefined();
  });

  it('filters invalid features and bounds the number forwarded without mutating owner data', () => {
    const input = observation({ features: { valid: 0.8, badNegative: -0.1, badLarge: 1.1, badInfinite: Infinity, 'invalid name': 0.3 } });
    expect(recentCvObservation(input, now)?.features).toEqual({ valid: 0.8 });
    expect(input.features.badNegative).toBe(-0.1);
    expect(recentCvObservation(observation({ features: {} }), now)).toBeUndefined();
    expect(Object.keys(recentCvObservation(observation({ features: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`feature${i}`, 0.5])) }), now)!.features)).toHaveLength(32);
  });

  it('rejects NaN quality and malformed feature objects at the runtime boundary', () => {
    expect(recentCvObservation(observation({ quality: NaN }), now)).toBeUndefined();
    expect(recentCvObservation(observation({ features: null as unknown as Record<string, number> }), now)).toBeUndefined();
    expect(recentCvObservation(observation({ features: [] as unknown as Record<string, number> }), now)).toBeUndefined();
  });
});

describe('heard conversation and explicit forgetting commands', () => {
  it('uses only actually spoken assistant sentences, leaving input messages unchanged', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', text: '今天很累', timestamp: 1 },
      { id: 'a1', role: 'assistant', text: '已听到。没有播出。', spokenText: ' 已听到。 ', interrupted: true, timestamp: 2 },
      { id: 'a2', role: 'assistant', text: '完全没有播出。', timestamp: 3 },
      { id: 'a3', role: 'assistant', text: '生成但未播出。', spokenText: ' ', timestamp: 4 },
    ];
    const heard = heardHistory(messages);
    expect(heard.map(m => m.text)).toEqual(['今天很累', '已听到。']);
    expect(heard[1].spokenText).toBe('已听到。'); expect(heard[1].interrupted).toBe(true);
    expect(messages[1].text).toBe('已听到。没有播出。');
  });

  it('summarizes an entire long call in backend-valid chunks, including early user statements', () => {
    const messages: ChatMessage[] = Array.from({ length: 40 }, (_, index): ChatMessage[] => [
      { id: `u${index}`, role: 'user', text: '用户内容'.repeat(50), timestamp: index * 2 },
      { id: `a${index}`, role: 'assistant', text: '已播出内容。'.repeat(250) + 'UNHEARD_END', spokenText: '已播出内容。'.repeat(250), timestamp: index * 2 + 1 },
    ]).flat();
    const chunks = summaryChunks(messages);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map(message => message.id)).toEqual(messages.map(message => message.id));
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
      expect(chunk.some(message => message.role === 'user')).toBe(true);
      expect(chunk.reduce((size, message) => size + message.text.length + (message.spokenText?.length ?? 0), 0)).toBeLessThanOrEqual(48_000);
      expect(chunk.some(message => message.text.includes('UNHEARD_END'))).toBe(false);
    }
    const recent = heardHistory(messages);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThanOrEqual(14);
    expect(recent.at(-1)?.id).toBe('a39');
  });

  it('bounds recent response history by effective character size as well as turn count', () => {
    const messages: ChatMessage[] = Array.from({ length: 7 }, (_, index): ChatMessage[] => [
      { id: `long-u${index}`, role: 'user', text: 'u'.repeat(4000), timestamp: index * 2 },
      { id: `long-a${index}`, role: 'assistant', text: 'a'.repeat(2500), spokenText: 'a'.repeat(2500), timestamp: index * 2 + 1 },
    ]).flat();
    const heard = heardHistory(messages);
    expect(heard.length).toBeLessThanOrEqual(14);
    expect(heard.at(-1)?.id).toBe('long-a6');
    expect(heard.reduce((size, message) => size + message.text.length + (message.spokenText?.length ?? 0), 0)).toBeLessThanOrEqual(48_000);
  });

  it('accepts explicit whole-call forgetting commands in all three languages', () => {
    for (const text of ['不要保存这次通话。', '删除这次通话', '忘掉这次通话', "Don’t save this call!", 'forget this call', 'do not save this call', '이 통화를 저장하지 마세요.', '이번 대화는 잊어주세요', '이 통화를 삭제해주세요']) expect(forgetCurrentCall(text), text).toBe(true);
  });

  it('leaves ambiguous, negated and quoted commands in conversation', () => {
    for (const text of ['我不知道要不要保存这次通话', '不要删除这次通话', '他说“删除这次通话”', 'please forget something', 'I said do not delete this call', '이번 통화를 저장할까요?']) expect(forgetCurrentCall(text), text).toBe(false);
  });
});
