import type { CvObservation } from '../../shared/types';

export interface CvAdapter {
  /** The adapter owns camera permission and cleanup. Called only after explicit visual-consent toggle. */
  start(context: { signal: AbortSignal; onObservation: (value: CvObservation) => void }): Promise<void>;
  stop(): void | Promise<void>;
}

let adapter: CvAdapter | null = null;
const subscribers = new Set<() => void>();

/** Integration seam for the CV owner; this module never opens a camera itself. */
export function registerCvAdapter(next: CvAdapter): () => void {
  if (adapter) throw new Error('A CV adapter is already registered');
  adapter = next; subscribers.forEach(fn => fn());
  return () => { if (adapter === next) { void next.stop(); adapter = null; subscribers.forEach(fn => fn()); } };
}

export function getCvAdapter(): CvAdapter | null { return adapter; }
export function subscribeCvAdapter(fn: () => void): () => void { subscribers.add(fn); return () => { subscribers.delete(fn); }; }

export function recentCvObservation(value: CvObservation | null, now = Date.now()): CvObservation | undefined {
  if (!value || value.source !== 'face' || !Number.isFinite(value.capturedAt) || now - value.capturedAt > 10_000 || value.capturedAt > now + 1000 || !Number.isFinite(value.quality) || value.quality < 0.5 || value.quality > 1 || !value.features || typeof value.features !== 'object') return undefined;
  const features = Object.fromEntries(Object.entries(value.features).filter(([key, score]) => /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(key) && Number.isFinite(score) && score >= 0 && score <= 1).slice(0, 32));
  if (!Object.keys(features).length) return undefined;
  return { source: 'face', capturedAt: value.capturedAt, quality: value.quality, features };
}
