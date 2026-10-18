import type { ConsolidateResult, MemoryCandidate, MemoryItem, SessionRecord, SummarizeResult } from '../../shared/types';

export interface MemorySnapshot {
  sessions: SessionRecord[];
  memories: MemoryItem[];
  blockedTexts: string[];
  deletedSessionIds: string[];
  /** Source summaries containing a user-deleted/edited fact must not reintroduce paraphrases. */
  excludedSourceIds: string[];
  lastConsolidatedAt: number;
  revision: number;
}

const empty = (): MemorySnapshot => ({ sessions: [], memories: [], blockedTexts: [], deletedSessionIds: [], excludedSourceIds: [], lastConsolidatedAt: 0, revision: 0 });
const normalize = (state: MemorySnapshot): MemorySnapshot => ({ ...empty(), ...state });
const keyOf = (kind: string, text: string) => `${kind}:${text.normalize('NFKC').trim().toLocaleLowerCase()}`;

/** Device-local storage only. A read/write transaction prevents late summaries resurrecting deletions. */
export class MemoryStore {
  private connection?: Promise<IDBDatabase>;
  constructor(private name = 'whitemood-memory-v1') {}

  private open(): Promise<IDBDatabase> {
    if (!this.connection) {
      this.connection = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('storage_unavailable')); return; }
        const req = indexedDB.open(this.name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('state');
        req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
        req.onerror = () => reject(req.error ?? new Error('storage_unavailable'));
        req.onblocked = () => reject(new Error('storage_blocked'));
      });
      this.connection.catch(() => { this.connection = undefined; });
    }
    return this.connection;
  }

  async read(): Promise<MemorySnapshot> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readonly');
      const req = tx.objectStore('state').get('snapshot');
      req.onsuccess = () => resolve(normalize(req.result ?? empty()));
      req.onerror = () => reject(req.error);
    });
  }

  private async mutate<T>(fn: (state: MemorySnapshot) => T): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite'); const store = tx.objectStore('state');
      const req = store.get('snapshot'); let result: T; let thrown: unknown;
      req.onsuccess = () => {
        try {
          const state: MemorySnapshot = normalize(req.result ?? empty()); result = fn(state); state.revision += 1;
          store.put(state, 'snapshot');
        } catch (error) { thrown = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(thrown ?? tx.error ?? new Error('storage_error'));
      tx.onabort = () => reject(thrown ?? tx.error ?? new Error('storage_error'));
    });
  }

  async saveSession(session: SessionRecord): Promise<boolean> {
    return this.mutate(state => {
      if (state.deletedSessionIds.includes(session.id)) return false;
      const index = state.sessions.findIndex(item => item.id === session.id);
      if (index < 0) state.sessions.push(structuredClone(session)); else state.sessions[index] = structuredClone(session);
      return true;
    });
  }

  private merge(state: MemorySnapshot, candidates: MemoryCandidate[], permitted: Set<string>) {
    const now = Date.now();
    for (const candidate of candidates) {
      const text = candidate.text.trim(); if (!text || state.blockedTexts.includes(keyOf(candidate.kind, text))) continue;
      const sources = [...new Set(candidate.sourceSessionIds)].filter(id => permitted.has(id) && !state.deletedSessionIds.includes(id) && !state.excludedSourceIds.includes(id));
      if (!sources.length) continue;
      const existing = state.memories.find(item => keyOf(item.kind, item.text) === keyOf(candidate.kind, text));
      if (existing) { existing.sourceSessionIds = [...new Set([...existing.sourceSessionIds, ...sources])]; }
      else state.memories.push({ id: crypto.randomUUID(), kind: candidate.kind, text, sourceSessionIds: sources, createdAt: now, updatedAt: now });
    }
  }

  async commitSummary(id: string, result: SummarizeResult): Promise<boolean> {
    return this.mutate(state => {
      const session = state.sessions.find(item => item.id === id);
      if (!session || state.deletedSessionIds.includes(id) || session.summaryStatus !== 'pending') return false;
      session.summary = structuredClone(result.summary); session.summaryStatus = 'ready';
      this.merge(state, result.memories, new Set([id])); return true;
    });
  }

  async setSummaryStatus(id: string, status: SessionRecord['summaryStatus']): Promise<void> {
    await this.mutate(state => { const item = state.sessions.find(s => s.id === id); if (item) item.summaryStatus = status; });
  }

  async applyConsolidation(revision: number, result: ConsolidateResult, sourceIds?: string[]): Promise<boolean> {
    return this.mutate(state => {
      if (state.revision !== revision) return false;
      const permitted = new Set(state.sessions.filter(s => s.summaryStatus === 'ready' && !state.excludedSourceIds.includes(s.id) && (!sourceIds || sourceIds.includes(s.id))).map(s => s.id));
      const previous = new Map(state.memories.map(item => [keyOf(item.kind, item.text), item]));
      state.memories = state.memories.filter(item => !item.sourceSessionIds.length || !item.sourceSessionIds.every(id => permitted.has(id)));
      this.merge(state, result.memories, permitted);
      state.memories = state.memories.map(item => {
        const prior = previous.get(keyOf(item.kind, item.text));
        return prior ? { ...item, id: prior.id, createdAt: prior.createdAt, updatedAt: prior.updatedAt } : item;
      });
      state.lastConsolidatedAt = Date.now(); return true;
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.mutate(state => {
      if (!state.deletedSessionIds.includes(id)) state.deletedSessionIds.push(id);
      state.sessions = state.sessions.filter(s => s.id !== id);
      // Remove every derived item touching this source, rather than retaining a contaminated summary.
      state.memories = state.memories.filter(item => !item.sourceSessionIds.includes(id));
    });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.mutate(state => {
      const item = state.memories.find(m => m.id === id);
      if (item) {
        state.blockedTexts.push(keyOf(item.kind, item.text));
        state.excludedSourceIds = [...new Set([...state.excludedSourceIds, ...item.sourceSessionIds])];
      }
      state.memories = state.memories.filter(m => m.id !== id);
    });
  }

  async editMemory(id: string, text: string): Promise<void> {
    await this.mutate(state => {
      const item = state.memories.find(m => m.id === id); const next = text.trim().slice(0, 600);
      if (!item || !next) return;
      state.blockedTexts.push(keyOf(item.kind, item.text)); item.text = next; item.updatedAt = Date.now();
      state.excludedSourceIds = [...new Set([...state.excludedSourceIds, ...item.sourceSessionIds])];
    });
  }

  async clear(): Promise<void> {
    await this.mutate(state => {
      state.deletedSessionIds = [...new Set([...state.deletedSessionIds, ...state.sessions.map(s => s.id)])];
      state.sessions = []; state.memories = []; state.blockedTexts = []; state.excludedSourceIds = []; state.lastConsolidatedAt = 0;
    });
  }
}

export function selectMemories(memories: MemoryItem[], query: string): MemoryItem[] {
  const terms = new Set(query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  const cjk = query.match(/[\p{Script=Han}\p{Script=Hangul}]/gu) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) terms.add(cjk[i] + cjk[i + 1]);
  const ranked = [...memories].map(item => {
    const text = item.text.toLowerCase(); const overlap = [...terms].filter(term => text.includes(term)).length;
    return { item, score: overlap * 5 + (item.kind === 'preference' ? 3 : 0) };
  }).sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt);
  const result: MemoryItem[] = []; let chars = 0;
  for (const { item } of ranked) {
    if (result.length >= 8) break;
    if (chars + item.text.length > 2000) continue;
    result.push(item); chars += item.text.length;
  }
  return result;
}
