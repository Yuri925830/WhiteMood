import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeechPlan, UserSettings } from '../shared/types';
import { getAvailableVoices, SpeechOutput, splitSentences } from '../src/audio/speech';

const plan: SpeechPlan = { style: 'warm', rate: 0.95, pitch: 1, pauseMs: 500 };
const settings: UserSettings = { language: 'en', rate: 1, silenceMs: 1100, memoryEnabled: false, voiceURI: '', captions: true };

function mockSpeech() {
  const queued: FakeUtterance[] = [];
  class FakeUtterance {
    constructor(public text: string) {}
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
  }
  const voices = [
    { lang: 'en-US', voiceURI: 'en-remote', localService: false },
    { lang: 'en-GB', voiceURI: 'en-local', localService: true },
    { lang: 'ko-KR', voiceURI: 'ko-local', localService: true },
  ];
  const engine = {
    getVoices: () => voices,
    speak: vi.fn((utterance: FakeUtterance) => { queued.push(utterance); utterance.onstart?.(); }),
    cancel: vi.fn(), resume: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  vi.stubGlobal('speechSynthesis', engine);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  return { engine, queued };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('system voice output', () => {
  it('splits Chinese, Korean and English punctuation without breaking decimal numbers', () => {
    expect(splitSentences('你好。 괜찮아요? I slept 6.5 hours. Thank you!')).toEqual(['你好。', '괜찮아요?', 'I slept 6.5 hours.', 'Thank you!']);
  });

  it('prefers local matching voices and explicitly fails for an absent language', async () => {
    mockSpeech();
    expect(getAvailableVoices('en').map(voice => voice.voiceURI)).toEqual(['en-local', 'en-remote']);
    await expect(new SpeechOutput().speak('你好', 'zh', plan, settings, { onSentence: vi.fn() })).rejects.toThrow('No zh-CN voice is installed');
  });

  it('records only completed sentences, and cancellation during a pause prevents queued continuation', async () => {
    vi.useFakeTimers();
    const { engine, queued } = mockSpeech();
    const output = new SpeechOutput();
    const onSentence = vi.fn();
    const promise = output.speak('First sentence. Second sentence.', 'en', plan, settings, { onSentence });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); await Promise.resolve();
    expect(queued).toHaveLength(1);
    expect(onSentence).not.toHaveBeenCalled();
    queued[0].onend?.();
    await Promise.resolve();
    expect(onSentence).toHaveBeenCalledExactlyOnceWith('First sentence.');
    output.cancel();
    await rejected;
    await vi.advanceTimersByTimeAsync(2000);
    expect(queued).toHaveLength(1);
    expect(engine.cancel).toHaveBeenCalledOnce();
  });

  it('does not record an interrupted sentence as spoken', async () => {
    const { queued } = mockSpeech();
    const output = new SpeechOutput(); const onSentence = vi.fn();
    const promise = output.speak('Still speaking.', 'en', plan, settings, { onSentence });
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); await Promise.resolve();
    expect(queued).toHaveLength(1);
    output.cancel();
    await rejected;
    expect(onSentence).not.toHaveBeenCalled();
  });
});
