import { describe, it, expect, beforeAll } from 'vitest';
import { login, client, expectStatus, Client, list, findOne } from './helpers';

/**
 * Procure-to-pay: requisition → (workflow) approval → purchase order → approval by finance →
 * goods receipt (stock + GRNI) → supplier invoice (three-way match) → accounts payable.
 */
describe('Procurement', () => {
  let purchasing: Client; let storekeeper: Client; let accountant: Client; let admin: Client;
  let supplier: any; let store: any; let product: any;
  let prId: string; let poId: string; let poItemId: string; let grnId: string;

  const qty = async () => Number((await list(admin, `/api/stock?store_id=${store.id}&product_id=${product.id}`))[0]?.quantity ?? 0);

  beforeAll(async () => {
    purchasing = client(await login('purchasing'));
    storekeeper = client(await login('storekeeper'));
    accountant = client(await login('accountant'));
    admin = client(await login('admin'));
    supplier = await findOne(purchasing, '/api/suppliers?pageSize=50', (s) => s.is_active !== false);
    store = await findOne(admin, '/api/stores?pageSize=50', (s) => s.code === 'FOOD');
    product = await findOne(admin, '/api/products?pageSize=200&search=DRY-002', (p) => p.sku === 'DRY-002');
  });

  it('a purchase requisition goes through the configured approval workflow', async () => {
    const pr = expectStatus(await purchasing.post('/api/purchase-requisitions', {
      store_id: store.id, priority: 'NORMAL', justification: 'Cooking oil running low (test)',
      items: [{ product_id: product.id, quantity: 10, estimated_unit_cost: 320 }],
    }), 201);
    prId = pr.body.id;
    expect(pr.body.status).toBe('PENDING_APPROVAL');

    // a PO cannot be raised against an unapproved requisition
    const early = await purchasing.post('/api/purchase-orders', { supplier_id: supplier.id, requisition_id: prId, store_id: store.id, items: [{ product_id: product.id, quantity: 10, unit_price: 320 }] });
    expect([400, 422]).toContain(early.status);

    // the approver (storekeeper per the seeded workflow) sees it in their inbox and approves
    const inbox = expectStatus(await storekeeper.get('/api/approvals'), 200).body.data as any[];
    const task = inbox.find((a) => a.entity_type === 'purchase_requisition' && a.entity_id === prId);
    expect(task, 'approval request routed to the storekeeper').toBeTruthy();
    expectStatus(await storekeeper.post(`/api/approvals/${task.id}/act`, { action: 'APPROVE', comment: 'ok' }), 200);
    const approved = expectStatus(await purchasing.get(`/api/purchase-requisitions/${prId}`), 200).body;
    expect(approved.status).toBe('APPROVED');
  });

  it('raises a purchase order that finance must approve (segregation of duties)', async () => {
    const po = expectStatus(await purchasing.post('/api/purchase-orders', {
      supplier_id: supplier.id, requisition_id: prId, store_id: store.id, items: [{ product_id: product.id, quantity: 10, unit_price: 320 }],
    }), 201);
    poId = po.body.id;
    expect(po.body.status).toBe('PENDING_APPROVAL');
    expect(Number(po.body.total)).toBeGreaterThanOrEqual(3200);
    expect((await purchasing.post(`/api/purchase-orders/${poId}/approve`, {})).status).toBe(403);   // purchasing officer lacks purchases.approve

    const inbox = expectStatus(await accountant.get('/api/approvals'), 200).body.data as any[];
    const task = inbox.find((a) => a.entity_type === 'purchase_order' && a.entity_id === poId);
    expect(task, 'PO approval routed to accounts manager').toBeTruthy();
    expectStatus(await accountant.post(`/api/approvals/${task.id}/act`, { action: 'APPROVE' }), 200);
    const detail = expectStatus(await purchasing.get(`/api/purchase-orders/${poId}`), 200).body;
    expect(detail.status).toBe('APPROVED');
    poItemId = detail.items[0].id;
    const pr = expectStatus(await purchasing.get(`/api/purchase-requisitions/${prId}`), 200).body;
    expect(pr.status).toBe('ORDERED');
  });

  it('receiving goods updates stock through the ledger and accrues GRNI', async () => {
    const before = await qty();
    const grn = expectStatus(await storekeeper.post('/api/grns', {
      purchase_order_id: poId, store_id: store.id, delivery_note_no: 'DN-TEST-1',
      items: [{ po_item_id: poItemId, product_id: product.id, received_qty: 10, accepted_qty: 10 }],
    }), 201);
    grnId = grn.body.id;
    expect(grn.body.status).toBe('COMPLETED');
    expect(await qty()).toBeCloseTo(before + 10, 3);
    const ledger = await list(admin, `/api/stock/ledger?store_id=${store.id}&product_id=${product.id}&movement_type=PURCHASE_RECEIPT&pageSize=5`);
    expect(ledger.some((m: any) => m.reference_id === grnId && Number(m.quantity) === 10)).toBe(true);
    const po = expectStatus(await purchasing.get(`/api/purchase-orders/${poId}`), 200).body;
    expect(['RECEIVED', 'PARTIALLY_RECEIVED', 'CLOSED']).toContain(po.status);
  });

  it('a supplier invoice is three-way matched and lands in accounts payable', async () => {
    const grn = expectStatus(await purchasing.get(`/api/grns/${grnId}`), 200).body;
    const grnItem = grn.items[0];
    const over = await purchasing.post('/api/supplier-invoices', {
      supplier_id: supplier.id, supplier_invoice_no: 'INV-TEST-OVER', purchase_order_id: poId, grn_ids: [grnId], invoice_date: grn.received_date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      items: [{ grn_item_id: grnItem.id, product_id: product.id, quantity: 12, unit_price: 320 }],
    });
    expect(over.status).toBe(400); // more than received

    const inv = expectStatus(await purchasing.post('/api/supplier-invoices', {
      supplier_id: supplier.id, supplier_invoice_no: 'INV-TEST-1', purchase_order_id: poId, grn_ids: [grnId], invoice_date: new Date().toISOString().slice(0, 10),
      items: [{ grn_item_id: grnItem.id, product_id: product.id, quantity: 10, unit_price: 320 }],
    }), 201);
    expect(inv.body.status).toBe('APPROVED');
    expect(Number(inv.body.balance)).toBeCloseTo(Number(inv.body.total), 2);
    // AP was accrued when the goods were received (DR Inventory / CR Accounts Payable); a perfectly
    // matched invoice therefore posts no further journal — only price/tax variances would.
    expect(grn.journal_entry_id).toBeTruthy();
    const grnJe = expectStatus(await accountant.get(`/api/journals/${grn.journal_entry_id}`), 200).body;
    const apCredit = grnJe.lines.filter((l: any) => Number(l.credit) > 0).reduce((s: number, l: any) => s + Number(l.credit), 0);
    expect(apCredit).toBeCloseTo(Number(inv.body.total), 2);
    expect(inv.body.journal_entry_id).toBeNull();

    const aging = expectStatus(await accountant.get('/api/supplier-invoices/aging'), 200).body;
    const row = aging.data.find((r: any) => (r.supplier_id ?? r.id) === supplier.id);
    expect(row).toBeTruthy();
    expect(Number(row.total ?? row.balance)).toBeGreaterThanOrEqual(Number(inv.body.total) - 0.01);

    // duplicate supplier invoice numbers are rejected
    const dup = await purchasing.post('/api/supplier-invoices', {
      supplier_id: supplier.id, supplier_invoice_no: 'INV-TEST-1', invoice_date: new Date().toISOString().slice(0, 10),
      items: [{ product_id: product.id, quantity: 1, unit_price: 320 }],
    });
    expect([400, 409, 422]).toContain(dup.status);
  });

  it('a waiter cannot raise purchase orders', async () => {
    const waiter = client(await login('waiter'));
    expect((await waiter.post('/api/purchase-orders', { supplier_id: supplier.id, items: [] })).status).toBe(403);
  });
});
