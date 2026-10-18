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
  const chunks: ChatMessage[][] = []; let chunk: ChatMessage[] = []; let chars = 0;
  for (const message of heardMessages(messages)) {
    const cost = message.text.length + (message.spokenText?.length ?? 0);
    if (message.role === 'user' && chunk.length && (chunk.length >= 60 || chars + cost > 32_000)) { chunks.push(chunk); chunk = []; chars = 0; }
    chunk.push(message); chars += cost;
  }
  if (chunk.some(message => message.role === 'user')) chunks.push(chunk);
  return chunks;
}

/** Explicit whole-call commands only; ambiguous deletion requests stay in normal conversation. */
export function forgetCurrentCall(text: string): boolean {
  const normalized = text.normalize('NFKC').trim().toLowerCase().replace(/[。.!！?？]+$/u, '');
  return /^(不要保存这次通话|这次通话不要记|不要记住这次对话|删除这次通话|忘掉这次通话|don['’]?t save (this|our) call|forget this call|delete this call|do not save this call|이 통화(는|를)? 저장하지 마(세요)?|이번 (통화|대화)(는|를)? (저장하지 마(세요)?|잊어(줘|주세요))|이 통화(를)? 삭제해(줘|주세요))$/u.test(normalized);
}
