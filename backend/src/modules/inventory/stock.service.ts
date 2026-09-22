import { PoolClient } from 'pg';
import { Errors, NotFound, BadRequest } from '../../core/errors';
import { postJournal, r2 } from '../finance/accounting.service';
import { notify } from '../../core/notify';

export type MovementType = 'OPENING' | 'PURCHASE_RECEIPT' | 'STORE_TRANSFER_OUT' | 'STORE_TRANSFER_IN' | 'ISSUE_TO_DEPARTMENT' | 'RETURN_TO_STORE' | 'STOCK_ADJUSTMENT' | 'SALE' | 'WASTE' | 'DAMAGE' | 'EXPIRY' | 'PRODUCTION' | 'CONSUMPTION' | 'DISPOSAL' | 'PURCHASE_RETURN';

export interface MoveInput {
  propertyId: string; storeId: string; productId: string; type: MovementType; quantity: number; // signed (+in / -out)
  unitCost?: number; referenceType?: string; referenceId?: string | null; referenceNumber?: string | null; departmentId?: string | null; outletId?: string | null;
  businessDate?: string | null; notes?: string | null; userId: string | null; batch?: { batchNo?: string | null; expiryDate?: string | null; serial?: string | null } | null; allowNegative?: boolean;
}

/**
 * Core stock ledger writer. Locks the balance row, validates availability, updates moving-average cost on receipts,
 * appends an immutable stock_movements row with balance_after. Returns the movement + cost used.
 */
export async function moveStock(client: PoolClient, m: MoveInput) {
  if (!m.quantity || Number.isNaN(m.quantity)) throw new BadRequest('Quantity is required');
  const product = (await client.query(`SELECT id, name, sku, cost_price, is_stock_item, track_batches, track_expiry FROM products WHERE id=$1`, [m.productId])).rows[0];
  if (!product) throw new NotFound('Product not found');
  if (!product.is_stock_item) return { movement: null, unitCost: Number(product.cost_price), skipped: true };
  await client.query(`INSERT INTO stock_balances (store_id, product_id, quantity, avg_cost) VALUES ($1,$2,0,$3) ON CONFLICT DO NOTHING`, [m.storeId, m.productId, product.cost_price]);
  const bal = (await client.query(`SELECT * FROM stock_balances WHERE store_id=$1 AND product_id=$2 FOR UPDATE`, [m.storeId, m.productId])).rows[0];
  const current = Number(bal.quantity);
  const qty = r4(m.quantity);
  let unitCost = m.unitCost ?? Number(bal.avg_cost) ?? Number(product.cost_price);
  let newAvg = Number(bal.avg_cost);
  if (qty > 0 && ['PURCHASE_RECEIPT', 'OPENING', 'STORE_TRANSFER_IN', 'RETURN_TO_STORE', 'PRODUCTION', 'STOCK_ADJUSTMENT'].includes(m.type) && m.unitCost !== undefined) {
    // moving average
    const totalVal = current * Number(bal.avg_cost) + qty * unitCost;
    newAvg = current + qty > 0 ? totalVal / (current + qty) : unitCost;
  } else if (qty < 0) {
    unitCost = Number(bal.avg_cost) || Number(product.cost_price);
    if (current + qty < -0.0001 && !m.allowNegative) {
      const store = (await client.query(`SELECT name FROM stores WHERE id=$1`, [m.storeId])).rows[0];
      throw Errors.insufficientStock(`${product.name} in ${store?.name ?? 'store'}`, current, -qty);
    }
  }
  const after = r4(current + qty);
  await client.query(`UPDATE stock_balances SET quantity=$3, avg_cost=$4, last_movement_at=now() WHERE store_id=$1 AND product_id=$2`, [m.storeId, m.productId, after, r4(newAvg)]);
  if (qty > 0 && m.unitCost !== undefined) await client.query(`UPDATE products SET cost_price=$2 WHERE id=$1`, [m.productId, r4(newAvg)]);
  let batchId: string | null = null;
  if (m.batch && (m.batch.batchNo || m.batch.expiryDate || m.batch.serial) && qty > 0) {
    batchId = (await client.query(`INSERT INTO stock_batches (store_id, product_id, batch_no, expiry_date, serial_number, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [m.storeId, m.productId, m.batch.batchNo ?? null, m.batch.expiryDate ?? null, m.batch.serial ?? null, qty, unitCost])).rows[0].id;
  } else if (qty < 0 && (product.track_batches || product.track_expiry)) {
    // FEFO consume batches
    let remaining = -qty;
    const batches = (await client.query(`SELECT * FROM stock_batches WHERE store_id=$1 AND product_id=$2 AND quantity > 0 AND status='AVAILABLE' ORDER BY expiry_date NULLS LAST, received_at FOR UPDATE`, [m.storeId, m.productId])).rows;
    for (const b of batches) { if (remaining <= 0) break; const take = Math.min(Number(b.quantity), remaining); await client.query(`UPDATE stock_batches SET quantity=quantity-$2 WHERE id=$1`, [b.id, take]); remaining -= take; batchId = batchId ?? b.id; }
  }
  const movement = (await client.query(
    `INSERT INTO stock_movements (property_id, store_id, product_id, movement_type, quantity, unit_cost, total_cost, balance_after, batch_id, reference_type, reference_id, reference_number, department_id, outlet_id, business_date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15, CURRENT_DATE),$16,$17) RETURNING *`,
    [m.propertyId, m.storeId, m.productId, m.type, qty, r4(unitCost), r4(qty * unitCost), after, batchId, m.referenceType ?? null, m.referenceId ?? null, m.referenceNumber ?? null, m.departmentId ?? null, m.outletId ?? null, m.businessDate ?? null, m.notes ?? null, m.userId])).rows[0];
  // low stock alert (only when crossing the reorder level downwards)
  if (qty < 0) {
    const p = (await client.query(`SELECT reorder_level, name FROM products WHERE id=$1`, [m.productId])).rows[0];
    if (after < -0.0001 && current >= -0.0001) {
      const store = (await client.query(`SELECT name FROM stores WHERE id=$1`, [m.storeId])).rows[0];
      await notify({ permission: 'inventory.view', propertyId: m.propertyId, type: 'NEGATIVE_STOCK', title: `Negative stock: ${p.name}`, body: `${store?.name ?? 'Store'} balance is ${after} after ${m.type} ${m.referenceNumber ?? ''}. Post the missing transfer/receipt or investigate.`, entityType: 'product', entityId: m.productId, link: `/inventory/stock?product_id=${m.productId}` });
    }
    if (Number(p.reorder_level) > 0 && current > Number(p.reorder_level) && after <= Number(p.reorder_level)) {
      await notify({ permission: 'inventory.view', propertyId: m.propertyId, type: 'LOW_STOCK', title: `Low stock: ${p.name}`, body: `Balance ${after} is at/below reorder level ${p.reorder_level}`, entityType: 'product', entityId: m.productId, link: '/inventory/stock', severity: 'WARNING' }, client);
    }
  }
  return { movement, unitCost: r4(unitCost), skipped: false };
}

const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

/** Resolve the active recipe (by effective date) for a menu item */
export async function activeRecipe(client: PoolClient, menuItemId: string, date?: string) {
  const r = await client.query(
    `SELECT r.*, COALESCE((SELECT json_agg(json_build_object('product_id', ri.product_id, 'quantity', ri.quantity, 'wastage_percent', ri.wastage_percent, 'unit_id', ri.unit_id)) FROM recipe_items ri WHERE ri.recipe_id=r.id), '[]') AS items
       FROM recipes r WHERE r.menu_item_id=$1 AND r.is_active AND r.effective_from <= COALESCE($2::date, CURRENT_DATE) AND (r.effective_to IS NULL OR r.effective_to >= COALESCE($2::date, CURRENT_DATE))
      ORDER BY r.effective_from DESC, r.version DESC LIMIT 1`, [menuItemId, date ?? null]);
  return r.rows[0] ?? null;
}

/**
 * Consume stock for a sold menu item: recipe ingredients (with wastage %) or the directly linked product.
 * Returns total cost (COGS) consumed. Never throws on missing recipe — non-stock items simply have zero COGS.
 */
export async function consumeForMenuItem(client: PoolClient, opts: { propertyId: string; storeId: string | null; menuItemId: string; quantity: number; orderId: string; orderNumber: string; outletId: string; businessDate: string; userId: string; modifiers?: any[] }): Promise<{ cogs: number; movements: any[] }> {
  if (!opts.storeId) return { cogs: 0, movements: [] };
  const movements: any[] = [];
  let cogs = 0;
  const recipe = await activeRecipe(client, opts.menuItemId, opts.businessDate);
  const lines: { productId: string; qty: number }[] = [];
  if (recipe && recipe.items.length) {
    for (const it of recipe.items) lines.push({ productId: it.product_id, qty: (Number(it.quantity) * (1 + Number(it.wastage_percent) / 100) * opts.quantity) / Number(recipe.yield_qty || 1) });
  } else {
    const mi = (await client.query(`SELECT product_id, product_qty FROM menu_items WHERE id=$1`, [opts.menuItemId])).rows[0];
    if (mi?.product_id) lines.push({ productId: mi.product_id, qty: Number(mi.product_qty) * opts.quantity });
  }
  for (const mod of opts.modifiers ?? []) if (mod.product_id && Number(mod.product_qty) > 0) lines.push({ productId: mod.product_id, qty: Number(mod.product_qty) * opts.quantity });
  for (const l of lines) {
    const { movement, unitCost, skipped } = await moveStock(client, { propertyId: opts.propertyId, storeId: opts.storeId, productId: l.productId, type: 'SALE', quantity: -l.qty, referenceType: 'ORDER', referenceId: opts.orderId, referenceNumber: opts.orderNumber, outletId: opts.outletId, businessDate: opts.businessDate, userId: opts.userId, allowNegative: true });
    if (!skipped) { movements.push(movement); cogs += l.qty * unitCost; }
  }
  return { cogs: r2(cogs), movements };
}

/** Post COGS journal for consumed stock: DR Cost of Sales / CR Inventory */
export async function postCogs(client: PoolClient, opts: { propertyId: string; amount: number; description: string; sourceType: string; sourceId: string; outletId?: string | null; departmentId?: string | null; businessDate: string; userId: string; cogsAccountId?: string | null; inventoryAccountId?: string | null; cogsKey?: string }) {
  if (opts.amount <= 0) return null;
  return postJournal(client, { propertyId: opts.propertyId, description: opts.description, sourceType: opts.sourceType, sourceId: opts.sourceId, businessDate: opts.businessDate, userId: opts.userId,
    lines: [
      { accountId: opts.cogsAccountId ?? undefined, mappingKey: opts.cogsAccountId ? undefined : (opts.cogsKey ?? 'COGS'), debit: opts.amount, outletId: opts.outletId, departmentId: opts.departmentId },
      { accountId: opts.inventoryAccountId ?? undefined, mappingKey: opts.inventoryAccountId ? undefined : 'INVENTORY', credit: opts.amount, outletId: opts.outletId },
    ] });
}

export async function stockOnHand(client: PoolClient, storeId: string, productId: string): Promise<number> {
  const r = await client.query(`SELECT quantity FROM stock_balances WHERE store_id=$1 AND product_id=$2`, [storeId, productId]);
  return Number(r.rows[0]?.quantity ?? 0);
}
