import { describe, expect, it } from 'vitest';
import { nativePasswordHash } from '../server/passwordHash';

describe('private password hasher input bounds', () => {
  it.each(['a'.repeat(129), '🙂'.repeat(129)])('rejects passwords beyond 128 Unicode characters before allocating a native hash', async password => {
    await expect(nativePasswordHash(password, 'a'.repeat(32))).rejects.toThrow('Invalid password hash input.');
  });

  it.each(['', 'a'.repeat(31), 'g'.repeat(32), 'A'.repeat(32)])('rejects malformed salts before allocating a native hash (%s)', async salt => {
    await expect(nativePasswordHash('Correct password 123', salt)).rejects.toThrow('Invalid password hash input.');
  });
});
