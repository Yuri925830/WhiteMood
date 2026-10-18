import { DurableObject } from 'cloudflare:workers';
import { nativePasswordHash } from './passwordHash';

/** Private binding RPC only. Passwords are never stored, logged, or exposed by HTTP. */
export class PasswordHasher extends DurableObject {
  async hashPassword(password: string, saltHex: string): Promise<string> {
    return nativePasswordHash(password, saltHex);
  }
}
