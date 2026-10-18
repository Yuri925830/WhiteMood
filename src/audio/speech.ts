import type { Language, SpeechPlan, UserSettings } from '../../shared/types';

const languageTags: Record<Language, string> = { zh: 'zh-CN', en: 'en-US', ko: 'ko-KR' };

export function getAvailableVoices(language: Language): SpeechSynthesisVoice[] {
  if (!globalThis.speechSynthesis) return [];
  return speechSynthesis.getVoices()
    .filter(voice => voice.lang.toLowerCase().replace(/_/g, '-').split('-')[0] === language)
    .sort((a, b) => Number(b.localService) - Number(a.localService) || Number(b.default) - Number(a.default));
}

/** Keep punctuation and hard-limit long clauses to avoid browser speech queue stalls. */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const parts = normalized.match(/[^。！？!?]+(?:[。！？!?]+[”’"']*|$)|[。！？!?]+/gu) ?? [normalized];
  const sentences: string[] = [];
  for (const part of parts) {
    // An English/Korean full stop is a boundary when followed by space/end. Decimal points survive.
    const chunks = part.match(/.+?(?:\.(?=\s|$)|$)/gu) ?? [part];
    for (const chunk of chunks) {
      let remaining = chunk.trim();
      while (remaining.length > 220) {
        const prefix = remaining.slice(0, 220);
        let breakAt = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('，'), prefix.lastIndexOf(','), prefix.lastIndexOf('、'), prefix.lastIndexOf(';'), prefix.lastIndexOf('；'));
        if (breakAt < 70) breakAt = 219;
        sentences.push(remaining.slice(0, breakAt + 1).trim());
        remaining = remaining.slice(breakAt + 1).trim();
      }
      if (remaining) sentences.push(remaining);
    }
  }
  return sentences;
}

export class SpeechOutput {
  private run?: AbortController;

  async speak(
    text: string,
    language: Language,
    plan: SpeechPlan,
    settings: UserSettings,
    callbacks: { onSentence: (sentence: string) => void },
  ): Promise<void> {
    this.cancel();
    if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) throw new Error('This browser does not support speech playback.');
    const run = new AbortController(); this.run = run;
    const { signal } = run;
    try {
      await waitForVoices(signal);
      ensureActive(signal);
      const voices = getAvailableVoices(language);
      const voice = settings.voiceURI ? voices.find(item => item.voiceURI === settings.voiceURI) : voices[0];
      if (!voice) throw new Error(settings.voiceURI
        ? `The selected ${languageTags[language]} voice is unavailable. Select an installed voice in settings.`
        : `No ${languageTags[language]} voice is installed. Add this language's speech voice to the operating system, then reload.`);
      const sentences = splitSentences(text);
      for (let i = 0; i < sentences.length; i++) {
        ensureActive(signal);
        const sentence = sentences[i];
        await playSentence(sentence, voice, plan, settings, signal);
        ensureActive(signal);
        // Only onend-confirmed audio enters shared conversation context.
        callbacks.onSentence(sentence);
        if (i < sentences.length - 1) await abortableDelay(clamp(plan.pauseMs, 0, 1600), signal);
      }
    } finally {
      if (this.run === run) this.run = undefined;
    }
  }

  cancel(): void {
    if (this.run) {
      this.run.abort(); this.run = undefined;
      globalThis.speechSynthesis?.cancel();
    }
  }
}

function abortError() { return new DOMException('Speech playback interrupted', 'AbortError'); }
function ensureActive(signal: AbortSignal) { if (signal.aborted) throw abortError(); }
function clamp(value: number, min: number, max: number) { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min; }

async function waitForVoices(signal: AbortSignal): Promise<void> {
  ensureActive(signal);
  if (speechSynthesis.getVoices().length) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); speechSynthesis.removeEventListener('voiceschanged', check); signal.removeEventListener('abort', abort); };
    const check = () => { if (speechSynthesis.getVoices().length) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, 1800);
    signal.addEventListener('abort', abort, { once: true });
    speechSynthesis.addEventListener('voiceschanged', check);
    check();
  });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  ensureActive(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function playSentence(text: string, voice: SpeechSynthesisVoice, plan: SpeechPlan, settings: UserSettings, signal: AbortSignal): Promise<void> {
  ensureActive(signal);
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice; utterance.lang = voice.lang;
    utterance.rate = clamp(settings.rate * plan.rate, 0.65, 1.4);
    utterance.pitch = clamp(plan.pitch, 0.75, 1.25);
    utterance.volume = 1;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(startTimer); clearTimeout(endTimer);
      signal.removeEventListener('abort', abort);
      utterance.onstart = null; utterance.onend = null; utterance.onerror = null;
      error ? reject(error) : resolve();
    };
    const abort = () => finish(abortError());
    const timeout = () => { finish(new Error('Speech playback did not complete. Check the selected system voice and restart the call.')); speechSynthesis.cancel(); };
    const startTimer = setTimeout(timeout, 15000);
    const endTimer = setTimeout(timeout, 180000);
    utterance.onstart = () => clearTimeout(startTimer);
    utterance.onend = () => finish();
    utterance.onerror = event => finish(signal.aborted ? abortError() : new Error(`Speech playback failed: ${event.error}`));
    signal.addEventListener('abort', abort, { once: true });
    try {
      speechSynthesis.resume();
      speechSynthesis.speak(utterance);
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
