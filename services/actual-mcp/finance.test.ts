import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as api from '@actual-app/api';
import { ActualConnection } from './connection.js';
import { readSecret } from './secrets.js';
import { errorFromCatch } from '../../utils/response.js';

vi.mock('@actual-app/api', () => ({ init: vi.fn(), downloadBudget: vi.fn(), sync: vi.fn(), shutdown: vi.fn() }));
const secret = 'DUMMY-DO-NOT-DEPLOY';
let directory: string;
let connection: ActualConnection;
let user: unknown;
let files: unknown;
const send = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'finance-check-'));
  for (const variable of [
    'ACTUAL_SESSION_TOKEN_FILE',
    'ACTUAL_BUDGET_SYNC_ID_FILE',
    'ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE',
    'BEARER_TOKEN_FILE',
  ]) {
    const file = join(directory, variable);
    writeFileSync(file, secret, { mode: 0o600 });
    vi.stubEnv(variable, file);
  }
  vi.stubEnv('ACTUAL_SERVER_URL', 'http://actual:5006');
  vi.stubEnv('ACTUAL_DATA_DIR', directory);
  vi.stubEnv('ACTUAL_PASSWORD', 'MUST-NOT-BE-USED');
  user = { offline: false, tokenExpired: false, userId: 'mock-owner', loginMethod: 'openid' };
  files = [{ groupId: secret, encryptKeyId: 'mock-key' }];
  send.mockImplementation(async (name: string): Promise<unknown> =>
    name === 'subscribe-get-user' ? user : name === 'get-remote-files' ? files : {}
  );
  vi.mocked(api.init).mockResolvedValue({ send } as unknown as Awaited<ReturnType<typeof api.init>>);
  vi.mocked(api.sync).mockResolvedValue(undefined);
  vi.mocked(api.downloadBudget).mockResolvedValue(undefined);
  connection = new ActualConnection();
});
afterEach(async () => {
  await connection.drainAndClose();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('finance deployment boundary', () => {
  it('uses only token auth, explicitly selects an encrypted budget and waits for sync before success', async () => {
    const operation = vi.fn(async (): Promise<string> => 'saved');
    await expect(connection.run(operation)).resolves.toBe('saved');
    expect(api.init).toHaveBeenCalledWith({
      dataDir: directory,
      serverURL: 'http://actual:5006',
      sessionToken: secret,
      verbose: false,
    });
    expect(api.downloadBudget).toHaveBeenCalledWith(secret, { password: secret });
    expect(api.sync).toHaveBeenCalledTimes(3);
    expect(operation.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(api.sync).mock.invocationCallOrder[1]);
  });
  it.each(['ACTUAL_SESSION_TOKEN_FILE', 'ACTUAL_BUDGET_SYNC_ID_FILE', 'ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE'])(
    'requires %s before initializing',
    async (variable) => {
      vi.stubEnv(variable, '');
      await expect(connection.run(async () => 'unreachable')).rejects.toThrow('initialization failed');
      expect(api.init).not.toHaveBeenCalled();
    }
  );
  it.each([null, [], [{ groupId: secret }], [{ groupId: 'another', encryptKeyId: 'key' }]])(
    'rejects an absent or unencrypted selected budget (%j)',
    async (remote) => {
      files = remote;
      await expect(connection.run(async () => 'unreachable')).rejects.toThrow('initialization failed');
      expect(api.downloadBudget).not.toHaveBeenCalled();
    }
  );
  it('sanitizes rejected init and encryption failures and does not retry', async () => {
    vi.mocked(api.init).mockRejectedValue(new Error(secret));
    await expect(connection.run(async () => 'unreachable')).rejects.toThrow('initialization failed');
    await expect(connection.run(async () => 'unreachable')).rejects.not.toThrow(secret);
    expect(api.init).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorFromCatch(new Error(secret)))).not.toContain(secret);
  });
  it('propagates encryption failure', async () => {
    vi.mocked(api.downloadBudget).mockRejectedValue(new Error(secret));
    await expect(connection.run(async () => 'unreachable')).rejects.toThrow('initialization failed');
    expect(api.sync).not.toHaveBeenCalled();
  });
  it.each([null, { tokenExpired: true }, { offline: true }])(
    'blocks reads and queued writes after auth failure (%j)',
    async (invalid) => {
      await connection.ensureReady();
      user = invalid;
      const operation = vi.fn(async (): Promise<string> => 'unreachable');
      const results = await Promise.allSettled([connection.run(operation), connection.run(operation)]);
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(operation).not.toHaveBeenCalled();
    }
  );
  it('blocks stale reads after refresh fails, regardless of a configured TTL', async () => {
    await connection.ensureReady();
    vi.stubEnv('ACTUAL_SYNC_TTL_MS', '-1');
    vi.mocked(api.sync).mockRejectedValue(new Error(secret));
    const operation = vi.fn(async (): Promise<string> => 'cached');
    await expect(connection.run(operation)).rejects.not.toThrow(secret);
    await expect(connection.run(operation)).rejects.toThrow('restart required');
    expect(operation).not.toHaveBeenCalled();
  });
  it('does not return success or replay a write after its sync fails', async () => {
    await connection.ensureReady();
    vi.mocked(api.sync).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(secret));
    const operation = vi.fn(async (): Promise<string> => 'saved');
    await expect(connection.run(operation)).rejects.toThrow('outcome unknown');
    await expect(connection.run(operation)).rejects.toThrow('restart required');
    await connection.drainAndClose();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('close-budget');
    expect(send.mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(api.shutdown).mock.invocationCallOrder[0]);
  });
  it('rejects structured operation errors', async () => {
    await expect(connection.run(async () => ({ error: secret }))).rejects.toThrow('outcome unknown');
  });
  it('rejects public and multiline secret files without echoing values', () => {
    const file = process.env.BEARER_TOKEN_FILE!;
    chmodSync(file, 0o644);
    expect(() => readSecret('BEARER_TOKEN_FILE')).toThrow('unprotected');
    chmodSync(file, 0o600);
    writeFileSync(file, `${secret}\n${secret}`);
    expect(() => readSecret('BEARER_TOKEN_FILE')).not.toThrow(secret);
    expect(() => readSecret('BEARER_TOKEN_FILE')).toThrow('unprotected');
  });
});
