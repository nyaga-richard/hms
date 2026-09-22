import { describe, it, expect, beforeAll } from 'vitest';
import { login, client, expectStatus, Client, list, findOne, businessDate } from './helpers';

/**
 * General ledger: balanced immutable journals, reversals instead of edits, period control, trial balance.
 */
describe('Accounting', () => {
  let accountant: Client; let reception: Client;
  let cash: any; let repairs: any; let today: string; let journalId: string;

  beforeAll(async () => {
    accountant = client(await login('accountant'));
    reception = client(await login('reception'));
    today = await businessDate(accountant);
    cash = await findOne(accountant, '/api/accounts?pageSize=500', (a) => a.code === '1010');
    repairs = await findOne(accountant, '/api/accounts?pageSize=500', (a) => a.code === '6200');
  });

  it('rejects an unbalanced journal', async () => {
    const res = await accountant.post('/api/journals', {
      description: 'Unbalanced test journal', entry_date: today,
      lines: [{ account_id: repairs.id, debit: 1000, credit: 0 }, { account_id: cash.id, debit: 0, credit: 900 }],
    });
    expect([400, 422]).toContain(res.status);
    expect(['UNBALANCED', 'UNBALANCED_JOURNAL']).toContain(res.body.error.code);
  });

  it('posts a balanced manual journal', async () => {
    const res = expectStatus(await accountant.post('/api/journals', {
      description: 'Manual test journal - petty repairs', entry_date: today, reference: 'TEST-JE',
      lines: [{ account_id: repairs.id, debit: 1500, credit: 0, description: 'Plumbing' }, { account_id: cash.id, debit: 0, credit: 1500 }],
    }), 201);
    journalId = res.body.id;
    expect(res.body.status).toBe('POSTED');
    expect(res.body.number).toMatch(/\w+/);
    expect(Number(res.body.total_debit)).toBeCloseTo(1500, 2);
    expect(Number(res.body.total_credit)).toBeCloseTo(1500, 2);
    const detail = expectStatus(await accountant.get(`/api/journals/${journalId}`), 200).body;
    expect(detail.lines).toHaveLength(2);
  });

  it('corrects by reversal: original stays, is marked REVERSED, and cannot be reversed twice', async () => {
    const rev = expectStatus(await accountant.post(`/api/journals/${journalId}/reverse`, { reason: 'Posted to the wrong account (test)' }), 200, 201);
    expect(rev.body.reverses_id).toBe(journalId);
    const original = expectStatus(await accountant.get(`/api/journals/${journalId}`), 200).body;
    expect(original.status).toBe('REVERSED');
    expect(original.reversed_by_id).toBe(rev.body.id);
    // the reversal mirrors the lines
    const mirrored = expectStatus(await accountant.get(`/api/journals/${rev.body.id}`), 200).body;
    const cashLine = mirrored.lines.find((l: any) => l.account_id === cash.id);
    expect(Number(cashLine.debit)).toBeCloseTo(1500, 2);
    const again = await accountant.post(`/api/journals/${journalId}/reverse`, { reason: 'twice' });
    expect(again.status).toBe(422);
  });

  it('the trial balance balances', async () => {
    const tb = expectStatus(await accountant.get(`/api/journals/trial-balance?from=${today.slice(0, 4)}-01-01&to=${today}`), 200).body;
    expect(tb.balanced).toBe(true);
    expect(Array.isArray(tb.rows)).toBe(true);
    expect(tb.rows.length).toBeGreaterThan(0);
  });

  it('blocks postings into a closed period until it is reopened', async () => {
    const period = expectStatus(await accountant.post('/api/accounting-periods', { name: 'TEST-2025-11', start_date: '2025-11-01', end_date: '2025-11-30' }), 201);
    expectStatus(await accountant.post(`/api/accounting-periods/${period.body.id}/close`, {}), 200);

    const blocked = await accountant.post('/api/journals', {
      description: 'Back-dated into closed period', entry_date: '2025-11-15',
      lines: [{ account_id: repairs.id, debit: 100, credit: 0 }, { account_id: cash.id, debit: 0, credit: 100 }],
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('CLOSED_PERIOD');

    expectStatus(await accountant.post(`/api/accounting-periods/${period.body.id}/reopen`, { reason: 'late adjustment (test)' }), 200);
    expectStatus(await accountant.post('/api/journals', {
      description: 'Back-dated after reopen', entry_date: '2025-11-15',
      lines: [{ account_id: repairs.id, debit: 100, credit: 0 }, { account_id: cash.id, debit: 0, credit: 100 }],
    }), 201);
  });

  it('receptionist cannot see or post journals; chart of accounts is data, not code', async () => {
    expect((await reception.get('/api/journals')).status).toBe(403);
    expect((await reception.post('/api/journals', { description: 'nope', lines: [] })).status).toBe(403);
    const accounts = await list(accountant, '/api/accounts?pageSize=500');
    expect(accounts.length).toBeGreaterThan(20);
    const created = expectStatus(await accountant.post('/api/accounts', { code: '6999', name: 'Test Sundry Expense', type: 'EXPENSE' }), 201);
    expect(created.body.code).toBe('6999');
  });
});
