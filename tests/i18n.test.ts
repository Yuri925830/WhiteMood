import { describe, expect, it } from 'vitest';
import { errorText, translations } from '../src/i18n';
import type { Language } from '../shared/types';

const supportedLanguages: Language[] = ['zh', 'en', 'ko'];
const operationalErrors = [
  'service_unavailable', 'microphone_denied', 'microphone_missing', 'audio_unsupported',
  'voice_unavailable', 'network', 'rate_limited', 'provider_error', 'storage_error',
  'summary_failed', 'playback_failed', 'cv_error', 'memory_busy',
  'cv_image_count', 'cv_image_invalid',
];

describe('product language coverage', () => {
  it('provides nonempty text for the same product states in every supported language', () => {
    const expected = Object.keys(translations.zh).sort();
    for (const language of supportedLanguages) {
      expect(Object.keys(translations[language]).sort()).toEqual(expected);
      for (const text of Object.values(translations[language])) expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it('explains every operational failure in the selected language without showing provider data', () => {
    for (const language of supportedLanguages) {
      for (const error of operationalErrors) {
        const message = errorText(error, language);
        expect(message).not.toBe(error);
        expect(message).not.toBe(translations[language].unknown);
      }
      expect(errorText('request failed: secret-token=123', language)).toBe(translations[language].unknown);
    }
  });
});
