import { describe, it, expect, beforeAll } from 'vitest';
import { login, client, expectStatus, Client, list, findOne } from './helpers';

/**
 * POS: cashier shift → order → send to kitchen/bar → settle.
 * Settling a bar sale must (a) close the order, (b) consume stock through the immutable stock ledger,
 * (c) post revenue + COGS journals, and (d) land in the cashier's shift for reconciliation.
 */
describe('Point of sale', () => {
  let bartender: Client; let admin: Client;
  let outlet: any; let tusker: any; let shiftId: string; let orderId: string; let qtyBefore: number; let orderTotal: number;

  beforeAll(async () => {
    bartender = client(await login('bartender'));
    admin = client(await login('admin'));
    outlet = await findOne(admin, '/api/outlets?pageSize=50', (o) => o.code === 'RBAR');
    const menu = expectStatus(await bartender.get(`/api/menus/for-outlet/${outlet.id}`), 200).body;
    const items = menu.categories.flatMap((c: any) => c.items);
    tusker = items.find((i: any) => i.name === 'Tusker Lager');
    expect(tusker, 'seeded menu item "Tusker Lager" on the rooftop bar').toBeTruthy();
    const stock = await list(admin, `/api/stock?store_id=${outlet.store_id}&product_id=${tusker.product_id}`);
    qtyBefore = Number(stock[0]?.quantity ?? 0);
  });

  it('cannot transact without an open cashier shift', async () => {
    const res = await bartender.post('/api/orders', { outlet_id: outlet.id, type: 'COUNTER', covers: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CLOSED_SHIFT');
  });

  it('opens a shift with a float (and refuses a second concurrent shift)', async () => {
    const res = expectStatus(await bartender.post('/api/shifts/open', { outlet_id: outlet.id, opening_float: 2000 }), 201);
    shiftId = res.body.id ?? res.body.shift?.id;
    expect(shiftId).toBeTruthy();
    const dup = await bartender.post('/api/shifts/open', { outlet_id: outlet.id, opening_float: 0 });
    expect(dup.status).toBe(400);
    expect(dup.body.error.code).toBe('SHIFT_ALREADY_OPEN');
  });

  it('takes an order, sends it to the bar and settles it in cash', async () => {
    const order = expectStatus(await bartender.post('/api/orders', { outlet_id: outlet.id, type: 'COUNTER', covers: 2 }), 201);
    orderId = order.body.id;
    const added = expectStatus(await bartender.post(`/api/orders/${orderId}/items`, { items: [{ menu_item_id: tusker.id, quantity: 2 }] }), 200, 201);
    expect((added.body.items as any[]).length).toBe(1);
    expectStatus(await bartender.post(`/api/orders/${orderId}/send`, {}), 200);

    const detail = expectStatus(await bartender.get(`/api/orders/${orderId}`), 200).body;
    const total = Number(detail.total);
    orderTotal = total;
    // menu prices are tax-inclusive; the bill adds the configured service charge on top
    expect(total).toBeGreaterThanOrEqual(2 * Number(tusker.price));
    expect(Number(detail.tax_total)).toBeGreaterThan(0);
    const settled = expectStatus(await bartender.post(`/api/orders/${orderId}/settle`, { payments: [{ payment_method_code: 'CASH', amount: total }], idempotency_key: `test-${orderId}` }), 200, 201);
    expect(settled.body.status ?? settled.body.order?.status).toBe('CLOSED');

    // replaying the same settlement is rejected (idempotency)
    const replay = await bartender.post(`/api/orders/${orderId}/settle`, { payments: [{ payment_method_code: 'CASH', amount: total }], idempotency_key: `test-${orderId}` });
    expect([400, 409, 422]).toContain(replay.status);
  });

  it('consumed stock via SALE movements in the immutable stock ledger', async () => {
    const stock = await list(admin, `/api/stock?store_id=${outlet.store_id}&product_id=${tusker.product_id}`);
    expect(Number(stock[0].quantity)).toBeCloseTo(qtyBefore - 2, 3);
    const ledger = await list(admin, `/api/stock/ledger?store_id=${outlet.store_id}&product_id=${tusker.product_id}&reference_type=ORDER&pageSize=5`);
    const sale = ledger.find((m: any) => m.reference_id === orderId);
    expect(sale).toBeTruthy();
    expect(sale.movement_type).toBe('SALE');
    expect(Number(sale.quantity)).toBeCloseTo(-2, 3);
  });

  it('posted balanced revenue and COGS journals for the sale', async () => {
    const order = expectStatus(await admin.get(`/api/orders/${orderId}`), 200).body;
    expect(order.journal_entry_id).toBeTruthy();
    expect(Number(order.cogs_total)).toBeGreaterThan(0);
    const je = expectStatus(await admin.get(`/api/journals/${order.journal_entry_id}`), 200).body;
    const dr = je.lines.reduce((s: number, l: any) => s + Number(l.debit), 0);
    const cr = je.lines.reduce((s: number, l: any) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(cr, 2);
    expect(dr).toBeGreaterThan(0);
  });

  it('closes the shift: cash variance requires a reason, exact cash closes cleanly', async () => {
    const summary = expectStatus(await bartender.get('/api/shifts/current'), 200).body;
    expect(summary.shift.id).toBe(shiftId);
    const expected = Number(summary.expected_cash);
    expect(expected).toBeCloseTo(2000 + orderTotal, 2);

    const short = await bartender.post(`/api/shifts/${shiftId}/close`, { actual_cash: expected - 100 });
    expect(short.status).toBe(400); // variance without a reason

    const closed = expectStatus(await bartender.post(`/api/shifts/${shiftId}/close`, { actual_cash: expected }), 200);
    expect(closed.body.status ?? closed.body.shift?.status).toBe('CLOSED');
    expect(Number(closed.body.variance ?? closed.body.shift?.variance ?? 0)).toBeCloseTo(0, 2);
  });

  it('a housekeeper cannot open a shift or create orders', async () => {
    const hk = client(await login('housekeeper'));
    expect((await hk.post('/api/shifts/open', { opening_float: 0 })).status).toBe(403);
    expect((await hk.post('/api/orders', { outlet_id: outlet.id, type: 'COUNTER' })).status).toBe(403);
  });
});
