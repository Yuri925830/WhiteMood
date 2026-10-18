import { describe, expect, it } from 'vitest';
import { isValidAccountId, normalizeAccountId, validateCredentials } from '../src/auth-validation';

describe('account input rules', () => {
  it('uses the same case-insensitive NFKC ID form as the server', () => {
    expect(normalizeAccountId('WhiteMood_１２')).toBe('whitemood_12');
    expect(isValidAccountId('WhiteMood_１２')).toBe(true);
    expect(isValidAccountId('Ｙｕｒｉ')).toBe(true);
    expect(normalizeAccountId('  Yuri  ')).toBe('yuri');
  });

  it.each(['ab', 'a'.repeat(25), 'with space', 'a-b', '한글계정', '中文账号', ''])('rejects unsupported ID %s', id => {
    expect(isValidAccountId(id)).toBe(false);
    expect(validateCredentials(id, 'password123')).toBe('INVALID_ID');
  });

  it.each(['abc', 'a'.repeat(24), 'User_123'])('accepts valid ID %s', id => {
    expect(validateCredentials(id, 'password123')).toBeNull();
  });

  it('enforces password length without trimming or normalizing the password', () => {
    expect(validateCredentials('yuri', '1234567')).toBe('INVALID_PASSWORD');
    expect(validateCredentials('yuri', 'x'.repeat(129))).toBe('INVALID_PASSWORD');
    expect(validateCredentials('yuri', ' 123456 ')).toBeNull();
    expect(validateCredentials('yuri', 'x'.repeat(128))).toBeNull();
  });
});
