export type CredentialError = 'INVALID_ID' | 'INVALID_PASSWORD';

export function normalizeAccountId(id: string): string {
  return id.normalize('NFKC').trim().toLowerCase();
}

export function isValidAccountId(id: string): boolean {
  return /^[a-z0-9_]{3,24}$/.test(normalizeAccountId(id));
}

export function validateCredentials(id: string, password: string): CredentialError | null {
  if (!isValidAccountId(id)) return 'INVALID_ID';
  if (password.length < 8 || password.length > 128) return 'INVALID_PASSWORD';
  return null;
}
