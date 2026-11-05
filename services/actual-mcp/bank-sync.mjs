// Pulls new bank transactions for every linked account (Enable Banking), the same as
// clicking "Bank sync" in Actual. Run by the actual-bank-sync service on a timer.
import api from '@actual-app/api';
import { readFileSync } from 'node:fs';

const secret = (name) => readFileSync(`/run/secrets/${name}`, 'utf8').trim();

await api.init({ dataDir: '/data', serverURL: 'http://actual:5006', sessionToken: secret('session-token'), verbose: false });
try {
  await api.downloadBudget(secret('budget-sync-id'), { password: secret('e2ee-password') });
  await api.runBankSync();
  await api.sync();
  console.log(new Date().toISOString(), 'bank sync ok');
} catch (error) {
  // Expired bank consent lands here: re-link the account in Actual (Enable Banking, ~every 180 days).
  console.error(new Date().toISOString(), 'bank sync failed:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await api.shutdown();
}
