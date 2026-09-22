import { describe, it, expect, beforeAll } from 'vitest';
import { login, client, expectStatus, Client, list, findOne } from './helpers';
import { pool } from '../src/db/pool';

/**
 * Inventory: every quantity change flows through the append-only stock ledger (stock_movements) and
 * stock_balances is derived from it. Adjustments/stocktakes require approval with segregation of duties.
 */
describe('Inventory & stock ledger', () => {
  let storekeeper: Client; let accountant: Client; let admin: Client;
  let foodStore: any; let kitchenStore: any; let hkStore: any; let sugar: any;

  const qty = async (storeId: string, productId: string) => {
    const rows = await list(admin, `/api/stock?store_id=${storeId}&product_id=${productId}`);
    return Number(rows[0]?.quantity ?? 0);
  };

  beforeAll(async () => {
    storekeeper = client(await login('storekeeper'));
    accountant = client(await login('accountant'));
    admin = client(await login('admin'));
    foodStore = await findOne(admin, '/api/stores?pageSize=50', (s) => s.code === 'FOOD');
    kitchenStore = await findOne(admin, '/api/stores?pageSize=50', (s) => s.code === 'KIT');
    hkStore = await findOne(admin, '/api/stores?pageSize=50', (s) => s.code === 'HK');
    sugar = await findOne(admin, '/api/products?pageSize=200&search=DRY-003', (p) => p.sku === 'DRY-003');
  });

  it('issues stock against an approved requisition (store → kitchen) through paired ledger movements', async () => {
    const before = await qty(foodStore.id, sugar.id);
    const beforeKit = await qty(kitchenStore.id, sugar.id);
    expect(before).toBeGreaterThanOrEqual(2);

    const req = expectStatus(await storekeeper.post('/api/requisitions', { store_id: foodStore.id, to_store_id: kitchenStore.id, purpose: 'test issue', items: [{ product_id: sugar.id, requested_qty: 2 }] }), 201);
    expect(['PENDING', 'APPROVED']).toContain(req.body.status);
    // issuing before approval is refused
    const early = await storekeeper.post(`/api/requisitions/${req.body.id}/issue`, {});
    if (req.body.status === 'PENDING') expect(early.status).toBe(422);
    if (req.body.status === 'PENDING') expectStatus(await storekeeper.post(`/api/requisitions/${req.body.id}/approve`, {}), 200);
    const issued = expectStatus(await storekeeper.post(`/api/requisitions/${req.body.id}/issue`, {}), 200);
    expect(['ISSUED', 'PARTIALLY_ISSUED']).toContain(issued.body.status ?? issued.body.requisition?.status);

    expect(await qty(foodStore.id, sugar.id)).toBeCloseTo(before - 2, 3);
    expect(await qty(kitchenStore.id, sugar.id)).toBeCloseTo(beforeKit + 2, 3);
    const ledger = await list(admin, `/api/stock/ledger?product_id=${sugar.id}&pageSize=10`);
    expect(ledger.some((m: any) => m.movement_type === 'STORE_TRANSFER_OUT' && Number(m.quantity) === -2 && m.store_id === foodStore.id)).toBe(true);
    expect(ledger.some((m: any) => m.movement_type === 'STORE_TRANSFER_IN' && Number(m.quantity) === 2 && m.store_id === kitchenStore.id)).toBe(true);
  });

  it('a stock adjustment waits for approval, enforces segregation of duties, then posts ledger + journal', async () => {
    const before = await qty(foodStore.id, sugar.id);
    const adj = expectStatus(await storekeeper.post('/api/stock-adjustments', { store_id: foodStore.id, type: 'STOCK_ADJUSTMENT', reason: 'Count correction (test)', items: [{ product_id: sugar.id, quantity: -1 }] }), 201);
    expect(adj.body.status).toBe('PENDING');
    expect(await qty(foodStore.id, sugar.id)).toBeCloseTo(before, 3);          // nothing moved yet

    expect((await storekeeper.post(`/api/stock-adjustments/${adj.body.id}/approve`, {})).status).toBe(403); // lacks approve permission
    const posted = expectStatus(await accountant.post(`/api/stock-adjustments/${adj.body.id}/approve`, {}), 200);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.journal_entry_id).toBeTruthy();
    expect(await qty(foodStore.id, sugar.id)).toBeCloseTo(before - 1, 3);

    const je = expectStatus(await accountant.get(`/api/journals/${posted.body.journal_entry_id}`), 200).body;
    const dr = je.lines.reduce((s: number, l: any) => s + Number(l.debit), 0);
    const cr = je.lines.reduce((s: number, l: any) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(cr, 2);
  });

  it('stocktake: count → review → approval by a different user posts the variance', async () => {
    const st = expectStatus(await storekeeper.post('/api/stocktakes', { store_id: hkStore.id, include_zero: false, notes: 'test stocktake' }), 201);
    const detail = expectStatus(await storekeeper.get(`/api/stocktakes/${st.body.id}`), 200).body;
    const line = (detail.items as any[]).find((i) => Number(i.system_qty) >= 3);
    expect(line, 'a housekeeping store line with stock').toBeTruthy();
    const system = Number(line.system_qty);
    const counted = system - 3;

    // blind count: every line is counted; one line is deliberately 3 short
    const counts = (detail.items as any[]).map((i) => ({ id: i.id, counted_qty: i.id === line.id ? counted : Number(i.system_qty) }));
    expectStatus(await storekeeper.post(`/api/stocktakes/${st.body.id}/count`, { items: counts }), 200);
    expectStatus(await storekeeper.post(`/api/stocktakes/${st.body.id}/submit`, {}), 200);
    expect((await storekeeper.post(`/api/stocktakes/${st.body.id}/approve`, {})).status).toBe(403);   // counter cannot approve
    const approved = expectStatus(await accountant.post(`/api/stocktakes/${st.body.id}/approve`, {}), 200);
    expect(approved.body.status).toBe('POSTED');
    expect(await qty(hkStore.id, line.product_id)).toBeCloseTo(counted, 3);

    // the store is free for the next stocktake
    const again = expectStatus(await storekeeper.post('/api/stocktakes', { store_id: hkStore.id }), 201);
    expectStatus(await storekeeper.post(`/api/stocktakes/${again.body.id}/cancel`, { reason: 'test cleanup' }), 200);
  });

  it('the stock ledger and journals are immutable at the database level', async () => {
    const mv = (await pool.query(`SELECT id FROM stock_movements ORDER BY created_at DESC LIMIT 1`)).rows[0];
    await expect(pool.query(`DELETE FROM stock_movements WHERE id=$1`, [mv.id])).rejects.toThrow();
    await expect(pool.query(`UPDATE stock_movements SET quantity=quantity+1 WHERE id=$1`, [mv.id])).rejects.toThrow();
    const je = (await pool.query(`SELECT id FROM journal_entries ORDER BY created_at DESC LIMIT 1`)).rows[0];
    await expect(pool.query(`UPDATE journal_entries SET total_debit=0 WHERE id=$1`, [je.id])).rejects.toThrow();
    await expect(pool.query(`DELETE FROM journal_lines WHERE journal_entry_id=$1`, [je.id])).rejects.toThrow();
    // and there is simply no API to edit or delete them
    expect((await admin.del(`/api/journals/${je.id}`)).status).toBe(404);
    expect((await admin.put(`/api/journals/${je.id}`, { description: 'x' })).status).toBe(404);
  });

  it('a waiter cannot touch inventory', async () => {
    const waiter = client(await login('waiter'));
    expect((await waiter.get('/api/stock')).status).toBe(403);
    expect((await waiter.post('/api/stock-adjustments', { store_id: foodStore.id, reason: 'x', items: [{ product_id: sugar.id, quantity: -1 }] })).status).toBe(403);
  });
});
