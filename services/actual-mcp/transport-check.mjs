import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import * as api from '@actual-app/api';
import { chmodSync, chownSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const dummy = 'DUMMY-DO-NOT-DEPLOY';
const directory = mkdtempSync('/tmp/actual-token-check-');
let rejected = false;
let validates = 0;
const mockActual = createServer((req, res) => {
  assert.equal(req.url, '/account/validate');
  assert.equal(req.headers['x-actual-token'], dummy);
  validates++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(rejected
    ? { status: 'error', reason: 'token-expired' }
    : { status: 'ok', data: { userId: 'dummy-owner', loginMethod: 'openid', permission: 'ADMIN' } }));
});
await new Promise(resolve => mockActual.listen(0, '127.0.0.1', resolve));
const mockUrl = `http://127.0.0.1:${mockActual.address().port}`;
try {
  await api.init({ dataDir: directory, serverURL: mockUrl, sessionToken: dummy, verbose: false });
  await api.shutdown();
  rejected = true;
  await assert.rejects(api.init({ dataDir: directory, serverURL: mockUrl, sessionToken: dummy, verbose: false }), /invalid or expired session token/);
  assert.equal(validates, 2);
  await new Promise(resolve => mockActual.close(resolve));
  await assert.rejects(api.init({ dataDir: directory, serverURL: mockUrl, sessionToken: dummy, verbose: false }), /offline or unreachable/);
  console.log('PASS: real Actual 26.10 token-only init, revoked-token and network rejection against mock origin');
} finally {
  mockActual.close();
  await api.shutdown();
  rmSync(directory, { recursive: true, force: true });
}

for (const name of ['session-token', 'budget-sync-id', 'e2ee-password', 'mcp-bearer']) {
  const path = `/run/secrets/${name}`;
  writeFileSync(path, dummy);
  chmodSync(path, 0o400);
  chownSync(path, 1026, 100);
}
const child = spawn('node', ['build/index.js', '--sse', '--enable-bearer', '--enable-write'], {
  uid: 1026, gid: 100, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH,
    ACTUAL_SERVER_URL: 'http://actual:5006', ACTUAL_DATA_DIR: '/data',
    ACTUAL_SESSION_TOKEN_FILE: '/run/secrets/session-token',
    ACTUAL_BUDGET_SYNC_ID_FILE: '/run/secrets/budget-sync-id',
    ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE: '/run/secrets/e2ee-password',
    BEARER_TOKEN_FILE: '/run/secrets/mcp-bearer',
  },
});
let logs = '';
let output = '';
child.stderr.on('data', data => { logs += data; });
child.stdout.on('data', data => { output += data; });
const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
const client = new Client({ name: 'disposable-finance-check', version: '1' });
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'transport process exited: ' + logs.replaceAll(dummy, '[redacted]'));
    try {
      const res = await fetch('http://127.0.0.1:3000/mcp');
      assert.equal(res.status, 401);
      break;
    } catch (error) {
      if (attempt === 99) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.equal((await fetch('http://127.0.0.1:3000/mcp', { headers: { Authorization: 'Bearer WRONG' } })).status, 401);
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${dummy}` } },
  }));
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  for (const name of ['get-transactions', 'get-accounts', 'get-rules', 'create-rule', 'update-rule', 'create-category', 'update-category', 'get-dashboards', 'add-dashboard-widget', 'update-dashboard-widget', 'organize-dashboard', 'update-transaction']) {
    assert(names.includes(name), `approved tool absent: ${name}`);
  }
  assert(!names.some(name => name.startsWith('delete-') || name === 'run-bank-sync' || name === 'remove-dashboard-widget' || name === 'set-budget-amount'));
  const unavailable = await client.callTool({ name: 'run-bank-sync', arguments: {} });
  assert.equal(unavailable.isError, true);
  const failedRead = await client.callTool({ name: 'get-accounts', arguments: {} });
  assert.equal(failedRead.isError, true);
  assert(!JSON.stringify(failedRead).includes(dummy));
  const second = await client.callTool({ name: 'get-accounts', arguments: {} });
  assert.equal(second.isError, true);
  assert(!logs.includes(dummy));
  assert.equal(output, '');
  console.log(`PASS: HTTP bearer boundary, ${names.length} allowed tools, failed network read, sanitized output`);
} finally {
  await client.close().catch(() => undefined);
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  clearTimeout(deadline);
}
