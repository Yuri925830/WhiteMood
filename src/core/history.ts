import type { ChatMessage } from '../../shared/types';

export function heardMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.flatMap(message => {
    if (message.role === 'user') return [message];
    const text = message.spokenText?.trim();
    return text ? [{ ...message, text, spokenText: text }] : [];
  });
}

export function heardHistory(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []; let chars = 0;
  for (const message of heardMessages(messages).slice(-14).reverse()) {
    const cost = message.text.length + (message.spokenText?.length ?? 0);
    if (result.length && chars + cost > 6000) break;
    result.unshift(message); chars += cost;
  }
  return result;
}

export function summaryChunks(messages: ChatMessage[]): ChatMessage[][] {
  const encoder = new TextEncoder();
  const groups: ChatMessage[][] = [];
  for (const message of heardMessages(messages)) {
    if (message.role === 'user') groups.push([message]);
    else if (groups.length) groups[groups.length - 1].push(message);
    else throw new Error('A summary cannot invent a user turn for assistant-only content.');
  }
  const chunks: ChatMessage[][] = []; let chunk: ChatMessage[] = []; let bytes = 0;
  for (const group of groups) {
    const chars = group.reduce((sum, message) => sum + message.text.length + (message.spokenText?.length ?? 0), 0);
    if (group.length > 80 || chars > 48_000 || group.some(message => message.text.length > 6000 || (message.spokenText?.length ?? 0) > 6000)) {
      throw new Error('A complete conversation turn exceeds the summary API limits (6000 characters per message, 80 messages and 48000 weighted characters per request). Original content was not truncated.');
    }
    // UTF-8 budgeting keeps Chinese/Korean inputs smaller than a character-only limit.
    // A single complete user/assistant group may exceed this soft budget; its provenance stays intact.
    const cost = group.reduce((sum, message) => sum + encoder.encode(message.text).byteLength + encoder.encode(message.spokenText ?? '').byteLength, 0);
    if (chunk.length && (bytes + cost > 4000 || chunk.length + group.length > 60)) { chunks.push(chunk); chunk = []; bytes = 0; }
    chunk.push(...group); bytes += cost;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/** Explicit whole-call commands only; ambiguous deletion requests stay in normal conversation. */
export function forgetCurrentCall(text: string): boolean {
  const normalized = text.normalize('NFKC').trim().toLowerCase().replace(/[。.!！?？]+$/u, '');
  return /^(不要保存这次通话|这次通话不要记|不要记住这次对话|删除这次通话|忘掉这次通话|don['’]?t save (this|our) call|forget this call|delete this call|do not save this call|이 통화(는|를)? 저장하지 마(세요)?|이번 (통화|대화)(는|를)? (저장하지 마(세요)?|잊어(줘|주세요))|이 통화(를)? 삭제해(줘|주세요))$/u.test(normalized);
}
