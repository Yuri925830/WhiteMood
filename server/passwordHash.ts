import { scrypt } from 'node:crypto';

let scryptInFlight = false;

/** Identical parameters for native Sites authentication and the private hasher. */
export async function nativePasswordHash(password: string, saltHex: string): Promise<string> {
  if (typeof password !== 'string' || password.length > 256 || [...password].length > 128 ||
      typeof saltHex !== 'string' || !/^[0-9a-f]{32}$/.test(saltHex)) {
    throw new Error('Invalid password hash input.');
  }
  // An isolate may host multiple actors: admit one 32 MiB native hash for all of
  // them, rejecting overlapping work instead of allocating an unbounded queue.
  if (scryptInFlight) throw new Error('Password hashing is temporarily busy.');
  scryptInFlight = true;
  try {
    return await new Promise<string>((resolve, reject) => {
      scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error); else resolve(key.toString('hex'));
      });
    });
  } finally { scryptInFlight = false; }
}
