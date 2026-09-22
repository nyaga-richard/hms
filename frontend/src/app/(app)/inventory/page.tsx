'use client';
import React, { useState } from 'react';
import { PackageMinus, AlertTriangle, History } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Modal } from '@/components/ui/dialog';
import { Label, NativeSelect, Textarea } from '@/components/ui/input';
import { LookupSelect } from '@/components/shared/form';
import { ProductLines, type ProductLine } from '@/components/inventory/product-lines';
import { fmtMoney, fmtNum, fmtDate, fmtDateTime, titleCase } from '@/lib/utils';

const MOVEMENT_TYPES = ['GRN', 'ISSUE', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE', 'ADJUSTMENT', 'WASTE', 'STOCKTAKE', 'RETURN', 'OPENING'];
/** Direct issue to a department/outlet (no requisition) — e.g. housekeeping collecting supplies from the main store. */
function IssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [store, setStore] = useState(''); const [dept, setDept] = useState(''); const [outlet, setOutlet] = useState(''); const [notes, setNotes] = useState(''); const [lines, setLines] = useState<ProductLine[]>([]);
  const issue = useAction(() => post('/stock/issue', { store_id: store, department_id: dept || null, outlet_id: outlet || null, notes: notes || null, items: lines.map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) })) }, true), { success: 'Stock issued', invalidate: ['/stock', '/journals'], onSuccess: () => { onOpenChange(false); setLines([]); } });
  return <Modal open={open} onOpenChange={onOpenChange} title="Issue stock" description="Issues consumables straight to a cost centre. Stock is expensed to the department's expense account via the stock ledger." size="lg"><div className="space-y-3">
    <div className="grid grid-cols-3 gap-3"><div className="flex flex-col gap-1"><Label>From store</Label><LookupSelect source="/stores" value={store} onChange={(v) => { setStore(v); setLines([]); }} allowEmpty={false} placeholder="Select store" /></div><div className="flex flex-col gap-1"><Label>Department (cost centre)</Label><LookupSelect source="/departments" value={dept} onChange={setDept} placeholder="None" /></div><div className="flex flex-col gap-1"><Label>Outlet</Label><LookupSelect source="/outlets" value={outlet} onChange={setOutlet} placeholder="None" /></div></div>
    {store && <ProductLines lines={lines} onChange={setLines} storeId={store} showCost />}
    <div className="flex flex-col gap-1"><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
    <div className="flex justify-end"><Button loading={issue.isPending} disabled={!store || lines.length === 0 || (!dept && !outlet)} onClick={() => issue.mutate(undefined as any)}><PackageMinus />Issue {lines.length} line{lines.length === 1 ? '' : 's'}</Button></div></div></Modal>;
}
/** Ledger drawer for one product in one store — the immutable movement history behind the balance. */
function LedgerModal({ row, onClose }: { row: any | null; onClose: () => void }) {
  const { currency } = useAuth();
  return <Modal open={!!row} onOpenChange={(o) => !o && onClose()} title={row ? <span className="flex items-center gap-2"><History className="h-4 w-4" />{row.product_name} · {row.store_name}</span> : ''} size="xl">{row && <div className="space-y-3">
    <KV cols={4} items={[['On hand', `${fmtNum(row.quantity, 3)} ${row.unit}`], ['Avg cost', fmtMoney(row.avg_cost, currency)], ['Value', fmtMoney(row.value, currency)], ['Reorder level', `${fmtNum(row.reorder_level, 2)} ${row.unit}`]]} />
    <DataTable path="/stock/ledger" query={{ store_id: row.store_id, product_id: row.product_id }} defaultSort="created_at" noSearch dense pageSize={20} exportName={`ledger_${row.sku}`} filters={[{ key: 'movement_type', label: 'Type', type: 'select', options: MOVEMENT_TYPES }]}
      columns={[{ key: 'created_at', label: 'When', type: 'datetime' }, { key: 'business_date', label: 'Biz date', type: 'date' }, { key: 'movement_type', label: 'Type', render: (r) => <Badge tone={Number(r.quantity) < 0 ? 'warning' : 'success'}>{titleCase(r.movement_type)}</Badge> }, { key: 'reference_number', label: 'Reference', render: (r) => <span>{r.reference_number ?? '—'}<div className="text-xs text-muted-foreground">{titleCase(r.reference_type ?? '')}</div></span> }, { key: 'quantity', label: 'Qty', type: 'number', decimals: 3 }, { key: 'unit_cost', label: 'Unit cost', type: 'money' }, { key: 'total_cost', label: 'Value', type: 'money' }, { key: 'balance_after', label: 'Balance', type: 'number', decimals: 3 }, { key: 'created_by_name', label: 'By' }, { key: 'notes', label: 'Notes' }]} /></div>}</Modal>;
}
export default function InventoryPage() {
  const { can, currency } = useAuth(); const { data: val } = useApi<any>('/stock/valuation');
  const [issue, setIssue] = useState(false); const [ledger, setLedger] = useState<any>(null); const [mode, setMode] = useState<'all' | 'low' | 'negative'>('all');
  return <div className="space-y-4">
    <PageHeader title="Stock levels" subtitle="Live on-hand quantities per store, valued at moving average cost. Every balance is backed by the immutable stock ledger." actions={<>{can('inventory.issue') && <Button onClick={() => setIssue(true)}><PackageMinus />Issue stock</Button>}</>} />
    <div className="grid gap-3 md:grid-cols-4">
      <div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">Total stock value</div><div className="text-2xl font-semibold tabular">{fmtMoney(val?.total_value, currency)}</div></div>
      <button type="button" onClick={() => setMode(mode === 'low' ? 'all' : 'low')} className={`rounded-lg border bg-card p-3 text-left ${mode === 'low' ? 'ring-2 ring-amber-500' : ''}`}><div className="text-xs text-muted-foreground flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-amber-500" />Below reorder level</div><div className="text-2xl font-semibold tabular">{val?.low_stock_count ?? 0}</div></button>
      <div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">Expiring ≤30 days</div><div className="text-2xl font-semibold tabular">{(val?.expiring_soon ?? []).length}</div></div>
      <div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">Stores</div><div className="text-2xl font-semibold tabular">{(val?.by_store ?? []).length}</div></div>
    </div>
    <Tabs defaultValue="stock"><TabsList><TabsTrigger value="stock">On hand</TabsTrigger><TabsTrigger value="valuation">Valuation</TabsTrigger><TabsTrigger value="expiry">Expiry</TabsTrigger><TabsTrigger value="ledger">Ledger</TabsTrigger></TabsList>
      <TabsContent value="stock"><DataTable path="/stock" query={{ low: mode === 'low' ? 'true' : undefined, negative: mode === 'negative' ? 'true' : undefined }} defaultSort="product_name" defaultOrder="asc" exportName="stock_on_hand" onRowClick={setLedger} searchPlaceholder="Search SKU, product, store…" toolbar={<div className="flex gap-1">{(['all', 'low', 'negative'] as const).map((m) => <Button key={m} size="sm" variant={mode === m ? 'default' : 'outline'} onClick={() => setMode(m)}>{m === 'all' ? 'All' : m === 'low' ? 'Low stock' : 'Negative'}</Button>)}</div>}
        filters={[{ key: 'store_id', label: 'Store', type: 'select', source: '/stores' }, { key: 'category_type', label: 'Category type', type: 'select', options: ['FOOD', 'BEVERAGE', 'HOUSEKEEPING', 'GUEST_SUPPLIES', 'MAINTENANCE', 'OFFICE', 'LINEN', 'SPA', 'OTHER'] }, { key: 'category_id', label: 'Category', type: 'select', source: '/product-categories' }]}
        columns={[{ key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product', render: (r) => <span className="font-medium">{r.product_name}</span> }, { key: 'category_name', label: 'Category' }, { key: 'store_name', label: 'Store' }, { key: 'quantity', label: 'On hand', render: (r) => <span className={`tabular ${Number(r.quantity) < 0 ? 'text-destructive font-semibold' : r.is_low ? 'text-amber-600 font-semibold' : ''}`}>{fmtNum(r.quantity, 3)} {r.unit}</span> }, { key: 'reorder_level', label: 'Reorder at', type: 'number', decimals: 2 }, { key: 'avg_cost', label: 'Avg cost', type: 'money' }, { key: 'value', label: 'Value', type: 'money' }, { key: 'last_movement_at', label: 'Last movement', type: 'datetime' }]} rowClassName={(r) => (r.is_low ? 'bg-amber-500/5' : '')} /></TabsContent>
      <TabsContent value="valuation"><div className="grid gap-4 lg:grid-cols-2"><Section title="By store"><ul className="divide-y text-sm">{(val?.by_store ?? []).map((s: any) => <li key={s.id} className="flex justify-between py-1.5"><span>{s.name} <span className="text-xs text-muted-foreground">{titleCase(s.type)} · {s.skus} SKUs</span></span><span className="tabular font-medium">{fmtMoney(s.value, currency)}</span></li>)}</ul></Section><Section title="By category"><ul className="divide-y text-sm">{(val?.by_category ?? []).map((c: any) => <li key={c.id} className="flex justify-between py-1.5"><span>{c.name} <span className="text-xs text-muted-foreground">{titleCase(c.type)}</span></span><span className="tabular font-medium">{fmtMoney(c.value, currency)}</span></li>)}</ul></Section></div></TabsContent>
      <TabsContent value="expiry"><DataTable path="/stock/expiry" query={{ days: 60 }} defaultSort="expiry_date" defaultOrder="asc" noSearch columns={[{ key: 'product_name', label: 'Product' }, { key: 'store_name', label: 'Store' }, { key: 'batch_number', label: 'Batch' }, { key: 'quantity', label: 'Qty', type: 'number', decimals: 3 }, { key: 'expiry_date', label: 'Expires', type: 'date' }, { key: 'days_left', label: 'Days left', render: (r) => <Badge tone={Number(r.days_left) <= 7 ? 'destructive' : Number(r.days_left) <= 30 ? 'warning' : 'muted'}>{r.days_left}</Badge> }]} emptyTitle="Nothing expiring" emptyHint="Batches with expiry dates within the next 60 days will appear here." /></TabsContent>
      <TabsContent value="ledger"><DataTable path="/stock/ledger" defaultSort="created_at" exportName="stock_ledger" filters={[{ key: 'store_id', label: 'Store', type: 'select', source: '/stores' }, { key: 'movement_type', label: 'Type', type: 'select', options: MOVEMENT_TYPES }]} columns={[{ key: 'created_at', label: 'When', type: 'datetime' }, { key: 'store_name', label: 'Store' }, { key: 'product_name', label: 'Product' }, { key: 'movement_type', label: 'Type', render: (r) => titleCase(r.movement_type) }, { key: 'reference_number', label: 'Reference' }, { key: 'quantity', label: 'Qty', type: 'number', decimals: 3 }, { key: 'total_cost', label: 'Value', type: 'money' }, { key: 'balance_after', label: 'Balance', type: 'number', decimals: 3 }, { key: 'created_by_name', label: 'By' }]} /></TabsContent>
    </Tabs>
    <IssueDialog open={issue} onOpenChange={setIssue} />
    <LedgerModal row={ledger} onClose={() => setLedger(null)} />
  </div>;
}
