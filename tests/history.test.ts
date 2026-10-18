import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../shared/types';
import { summaryChunks } from '../src/core/history';
import { parseSummarize } from '../server/validation';

const bytes = (messages: ChatMessage[]) => messages.reduce((sum, message) => sum + new TextEncoder().encode(message.text).byteLength + new TextEncoder().encode(message.spokenText ?? '').byteLength, 0);

describe('summary request budgets preserve actual multilingual evidence', () => {
  it.each(['今天想聊聊。', '오늘은 대화를 나누고 싶어요. ', 'I would like to talk today. ', '中文 English 한국어 🌿 '])('packs complete turns under the UTF-8 soft budget for %s', phrase => {
    const messages: ChatMessage[] = Array.from({ length: 20 }, (_, index) => [
      { id: `u${index}`, role: 'user' as const, text: phrase.repeat(10), timestamp: index * 2 },
      { id: `a${index}`, role: 'assistant' as const, text: phrase.repeat(5) + 'UNHEARD', spokenText: phrase.repeat(5).trim(), timestamp: index * 2 + 1 },
    ]).flat();
    const chunks = summaryChunks(messages);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map(message => message.id)).toEqual(messages.map(message => message.id));
    expect(chunks.flat().filter(message => message.role === 'user').map(message => message.text).join('')).toBe(messages.filter(message => message.role === 'user').map(message => message.text).join(''));
    for (const chunk of chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(4000);
      expect(chunk[0].role).toBe('user');
      expect(chunk.at(-1)?.role).toBe('assistant');
      expect(chunk.some(message => message.text.includes('UNHEARD'))).toBe(false);
      expect(() => parseSummarize({ language: 'zh', sessionId: 'real-session', messages: chunk })).not.toThrow();
    }
  });

  it('retains an oversized but API-valid complete turn without splitting identities or truncation', () => {
    const messages: ChatMessage[] = [{ id: 'original-u', role: 'user', text: '中'.repeat(2000), timestamp: 1 }, { id: 'original-a', role: 'assistant', text: '네'.repeat(1000), spokenText: '네'.repeat(1000), timestamp: 2 }];
    const chunks = summaryChunks(messages);
    expect(chunks).toEqual([messages]); expect(bytes(chunks[0])).toBeGreaterThan(4000);
    expect(() => parseSummarize({ language: 'zh', sessionId: 'real-session', messages: chunks[0] })).not.toThrow();
  });

  it('fails explicitly for an invalid long message and leaves the source untouched', () => {
    const messages: ChatMessage[] = [{ id: 'original-long-u', role: 'user', text: '中'.repeat(6001), timestamp: 1 }];
    expect(() => summaryChunks(messages)).toThrow(/not truncated/);
    expect(messages[0].text).toHaveLength(6001);
  });

  it('fails for a complete turn beyond the API weighted hard limit instead of adding synthetic user context', () => {
    const messages: ChatMessage[] = [{ id: 'real-u', role: 'user', text: 'A real user utterance', timestamp: 0 }, ...Array.from({ length: 5 }, (_, index): ChatMessage => ({ id: `real-a${index}`, role: 'assistant', text: 'a'.repeat(6000), spokenText: 'a'.repeat(6000), timestamp: index + 1 }))];
    expect(() => summaryChunks(messages)).toThrow(/48000/);
    expect(messages).toHaveLength(6);
  });
});
