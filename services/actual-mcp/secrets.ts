import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export function readSecret(variable: string): string {
  try {
    const file = process.env[variable];
    if (!file) throw new Error();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error();
      const value = readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
      if (!value || /[\r\n\0]/.test(value)) throw new Error();
      return value;
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error(`Missing or unprotected secret file: ${variable}`);
  }
}

export function loadOwnerSecrets(): { sessionToken: string; budgetId: string; encryptionPassword: string } {
  return {
    sessionToken: readSecret('ACTUAL_SESSION_TOKEN_FILE'),
    budgetId: readSecret('ACTUAL_BUDGET_SYNC_ID_FILE'),
    encryptionPassword: readSecret('ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE'),
  };
}
