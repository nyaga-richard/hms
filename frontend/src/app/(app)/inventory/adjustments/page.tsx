'use client';
import React, { useState } from 'react';
import { Plus, Check, X, Trash2 } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, KV } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { LookupSelect, ConfirmDialog } from '@/components/shared/form';
import { ProductLines, LinesTable, type ProductLine } from '@/components/inventory/product-lines';
import { ApprovalTrail } from '@/components/shared/approval-trail';
import { AuditTrail } from '@/components/shared/audit-trail';
import { fmtDateTime, fmtMoney, fmtNum, titleCase } from '@/lib/utils';

const TYPES = ['STOCK_ADJUSTMENT', 'WASTE', 'DAMAGE', 'EXPIRY', 'DISPOSAL'];
const WASTE = ['WASTE', 'DAMAGE', 'EXPIRY', 'DISPOSAL'];
/** Adjustments & waste. Waste types always reduce stock (positive qty entered). Stock adjustments can be +/- or "set to". Approval routes via configurable workflow. */
function NewAdjustment({ open, onOpenChange, onCreated, defaultType }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (a: any) => void; defaultType: string }) {
  const { can } = useAuth();
  const [f, setF] = useState<any>({ store_id: '', type: defaultType, reason: '', department_id: '', outlet_id: '', notes: '', mode: 'DELTA' }); const [lines, setLines] = useState<ProductLine[]>([]);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v })); const isWaste = WASTE.includes(f.type);
  const create = useAction(() => post('/stock-adjustments', { store_id: f.store_id, type: f.type, reason: f.reason, department_id: f.department_id || null, outlet_id: f.outlet_id || null, notes: f.notes || null, items: lines.map((l) => (isWaste ? { product_id: l.product_id, quantity: Math.abs(Number(l.quantity)), reason: l.notes || null } : f.mode === 'SET' ? { product_id: l.product_id, new_qty: Number(l.quantity), reason: l.notes || null } : { product_id: l.product_id, quantity: Number(l.quantity), reason: l.notes || null })) }, true), { success: 'Submitted', invalidate: ['/stock-adjustments', '/approvals'], onSuccess: (a: any) => { onOpenChange(false); setLines([]); onCreated(a); } });
  return <Modal open={open} onOpenChange={onOpenChange} title={isWaste ? 'Record waste / damage' : 'Stock adjustment'} size="xl"><div className="space-y-3">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="flex flex-col gap-1"><Label>Type</Label><NativeSelect value={f.type} onChange={(e) => set('type', e.target.value)}>{TYPES.filter((t) => (WASTE.includes(t) ? can('inventory.waste') : can('inventory.adjust'))).map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</NativeSelect></div>
      <div className="flex flex-col gap-1"><Label>Store</Label><LookupSelect source="/stores" value={f.store_id} onChange={(v) => { set('store_id', v); setLines([]); }} allowEmpty={false} placeholder="Select store" /></div>
      <div className="flex flex-col gap-1 col-span-2"><Label>Reason</Label><Input value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder={isWaste ? 'Spoiled in cold room after power outage' : 'Count correction after audit'} /></div>
      <div className="flex flex-col gap-1"><Label>Department (cost centre)</Label><LookupSelect source="/departments" value={f.department_id} onChange={(v) => set('department_id', v)} placeholder="None" /></div>
      <div className="flex flex-col gap-1"><Label>Outlet</Label><LookupSelect source="/outlets" value={f.outlet_id} onChange={(v) => set('outlet_id', v)} placeholder="None" /></div>
      {!isWaste && <div className="flex flex-col gap-1"><Label>Quantity means</Label><div className="flex h-9 rounded-md border p-0.5">{[['DELTA', '± change'], ['SET', 'New on-hand']].map(([k, l]) => <button type="button" key={k} onClick={() => set('mode', k)} className={`flex-1 rounded text-xs ${f.mode === k ? 'bg-primary text-primary-foreground' : ''}`}>{l}</button>)}</div></div>}
      <div className="flex flex-col gap-1"><Label>Notes</Label><Input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
    </div>
    {f.store_id ? <ProductLines lines={lines} onChange={setLines} storeId={f.store_id} qtyLabel={isWaste ? 'Wasted qty' : f.mode === 'SET' ? 'New quantity' : '± Quantity'} showCost allowNotes /> : <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">Select a store first.</div>}
    <div className="flex justify-end"><Button loading={create.isPending} disabled={!f.store_id || f.reason.length < 2 || lines.length === 0} onClick={() => create.mutate(undefined as any)}>{isWaste ? <Trash2 /> : <Check />}Submit for approval</Button></div>
  </div></Modal>;
}
function AdjustmentDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, currency } = useAuth(); const { data: a, refetch } = useApi<any>(id ? `/stock-adjustments/${id}` : null); const [reject, setReject] = useState(false);
  const inv = ['/stock-adjustments', '/stock', '/approvals', '/journals'];
  const approveM = useAction(() => post(`/stock-adjustments/${id}/approve`, {}), { success: 'Approved & posted', invalidate: inv, onSuccess: () => refetch() });
  const rejectM = useAction((v: any) => post(`/stock-adjustments/${id}/reject`, v), { success: 'Rejected', invalidate: inv, onSuccess: () => { setReject(false); refetch(); } });
  if (!id) return null; const isWaste = a && WASTE.includes(a.type);
  return <Modal open={!!id} onOpenChange={(o) => !o && onClose()} title={a ? <span className="flex items-center gap-2">{a.number} <Badge tone={isWaste ? 'warning' : 'muted'}>{titleCase(a.type)}</Badge> <StatusBadge status={a.status} /></span> : 'Adjustment'} size="lg">{a && <div className="space-y-4">
    <KV cols={3} items={[['Store', a.store_name], ['Reason', a.reason], ['Cost centre', a.department_name ?? a.outlet_name ?? '—'], ['Created', `${a.created_by_name} · ${fmtDateTime(a.created_at)}`], ['Approved', a.approved_by_name ? `${a.approved_by_name} · ${fmtDateTime(a.approved_at)}` : '—'], ['Total value', <span key="v" className={Number(a.total_value) < 0 ? 'text-destructive' : ''}>{fmtMoney(a.total_value, currency)}</span>]]} />
    <LinesTable rows={a.items} columns={[{ key: 'product_name', label: 'Product', render: (i) => <div><div className="font-medium">{i.product_name}</div><div className="text-xs text-muted-foreground">{i.sku} · {i.unit}{i.reason ? ` · ${i.reason}` : ''}</div></div> }, { key: 'previous_qty', label: 'Before', align: 'right', render: (i) => fmtNum(i.previous_qty, 3) }, { key: 'variance_qty', label: 'Change', align: 'right', render: (i) => <span className={Number(i.variance_qty) < 0 ? 'text-destructive' : 'text-emerald-600'}>{Number(i.variance_qty) > 0 ? '+' : ''}{fmtNum(i.variance_qty, 3)}</span> }, { key: 'new_qty', label: 'After', align: 'right', render: (i) => fmtNum(i.new_qty, 3) }, { key: 'unit_cost', label: 'Unit cost', align: 'right', render: (i) => fmtMoney(i.unit_cost, currency) }, { key: 'value', label: 'Value', align: 'right', render: (i) => fmtMoney(i.value, currency) }]} />
    {a.status === 'PENDING' && can(isWaste ? 'inventory.approve_waste' : 'inventory.approve_adjustment') && <div className="flex gap-2"><Button loading={approveM.isPending} onClick={() => approveM.mutate(undefined as any)}><Check />Approve & post</Button><Button variant="outline" onClick={() => setReject(true)}><X />Reject</Button></div>}
    {a.journal_entry_id && <div className="text-xs text-muted-foreground">Posted to ledger · journal <a className="underline" href={`/finance/journals?id=${a.journal_entry_id}`}>{a.journal_entry_id.slice(0, 8)}</a></div>}
    <ApprovalTrail approval={a.approval} />
    <AuditTrail entity="stock_adjustment" entityId={id} />
    <ConfirmDialog open={reject} onOpenChange={setReject} title="Reject adjustment" destructive confirmLabel="Reject" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => rejectM.mutateAsync(v)} />
  </div>}</Modal>;
}
export default function AdjustmentsPage() {
  const { can } = useAuth(); const [open, setOpen] = useState<string | null>(null); const [sel, setSel] = useState<string | null>(null);
  return <div className="space-y-4">
    <PageHeader title="Adjustments & waste" subtitle="Waste, damage, expiry and count corrections — all approved through the configured workflow and posted as immutable stock movements with a matching journal." actions={<>{can('inventory.waste') && <Button variant="outline" onClick={() => setOpen('WASTE')}><Trash2 />Record waste</Button>}{can('inventory.adjust') && <Button onClick={() => setOpen('STOCK_ADJUSTMENT')}><Plus />Adjustment</Button>}</>} />
    <DataTable path="/stock-adjustments" defaultSort="created_at" onRowClick={(r) => setSel(r.id)} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['PENDING', 'APPROVED', 'POSTED', 'REJECTED'] }, { key: 'type', label: 'Type', type: 'select', options: TYPES }, { key: 'store_id', label: 'Store', type: 'select', source: '/stores' }]}
      columns={[{ key: 'number', label: 'No.' }, { key: 'created_at', label: 'Date', type: 'datetime' }, { key: 'type', label: 'Type', render: (r) => <Badge tone={WASTE.includes(r.type) ? 'warning' : 'muted'}>{titleCase(r.type)}</Badge> }, { key: 'store_name', label: 'Store' }, { key: 'reason', label: 'Reason' }, { key: 'item_count', label: 'Lines', type: 'number', decimals: 0 }, { key: 'total_value', label: 'Value', type: 'money' }, { key: 'created_by_name', label: 'By' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
    {open && <NewAdjustment open={!!open} onOpenChange={(o) => !o && setOpen(null)} defaultType={open} onCreated={(a) => setSel(a.id)} />}
    <AdjustmentDetail id={sel} onClose={() => setSel(null)} />
  </div>;
}
