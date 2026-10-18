import { WhiteMoodController } from './controller';
import { MemoryStore } from '../memory/store';

/** The server supplies a stable account UUID; no shared anonymous records are migrated. */
export function createAccountController(userId: string): WhiteMoodController {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) throw new Error('Invalid account identifier');
  return new WhiteMoodController({
    store: new MemoryStore(`whitemood-memory-v1:${userId}`),
    settingsKey: `whitemood-settings-v1:${userId}`,
  });
}
