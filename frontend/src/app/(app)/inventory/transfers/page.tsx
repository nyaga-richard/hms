'use client';
import React, { useState } from 'react';
import { Plus, Truck, PackageCheck, ArrowRight } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, KV } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { LookupSelect, ConfirmDialog } from '@/components/shared/form';
import { Switch } from '@/components/ui/misc';
import { ProductLines, LinesTable, type ProductLine } from '@/components/inventory/product-lines';
import { AuditTrail } from '@/components/shared/audit-trail';
import { fmtDateTime, fmtMoney, fmtNum } from '@/lib/utils';

/** Store-to-store transfer: DRAFT → IN_TRANSIT (stock leaves source) → COMPLETED (stock arrives; shortages become variance). */
function NewTransfer({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (t: any) => void }) {
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [notes, setNotes] = useState(''); const [dispatch, setDispatch] = useState(true); const [lines, setLines] = useState<ProductLine[]>([]);
  const create = useAction(() => post('/stock-transfers', { from_store_id: from, to_store_id: to, notes: notes || null, dispatch, items: lines.map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity) })) }, true), { success: dispatch ? 'Transfer dispatched' : 'Transfer saved', invalidate: ['/stock-transfers', '/stock'], onSuccess: (t: any) => { onOpenChange(false); setLines([]); onCreated(t); } });
  return <Modal open={open} onOpenChange={onOpenChange} title="New stock transfer" size="xl"><div className="space-y-3">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end"><div className="flex flex-col gap-1"><Label>From store</Label><LookupSelect source="/stores" value={from} onChange={(v) => { setFrom(v); setLines([]); }} allowEmpty={false} placeholder="Source" /></div><div className="flex flex-col gap-1"><Label>To store</Label><LookupSelect source="/stores" value={to} onChange={setTo} allowEmpty={false} placeholder="Destination" /></div><div className="flex flex-col gap-1 col-span-2"><Label>Notes</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div></div>
    {from ? <ProductLines lines={lines} onChange={setLines} storeId={from} showCost /> : <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">Select the source store first.</div>}
    <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-sm"><Switch checked={dispatch} onCheckedChange={setDispatch} /> Dispatch immediately (stock leaves source store now)</label><Button loading={create.isPending} disabled={!from || !to || from === to || lines.length === 0} onClick={() => create.mutate(undefined as any)}><Truck />{dispatch ? 'Dispatch transfer' : 'Save draft'}</Button></div>
  </div></Modal>;
}
function TransferDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, currency } = useAuth(); const { data: t, refetch } = useApi<any>(id ? `/stock-transfers/${id}` : null);
  const [receiving, setReceiving] = useState(false); const [qty, setQty] = useState<Record<string, string>>({}); const [notes, setNotes] = useState(''); const [cancel, setCancel] = useState(false);
  const inv = ['/stock-transfers', '/stock'];
  const dispatchM = useAction(() => post(`/stock-transfers/${id}/dispatch`), { success: 'Dispatched', invalidate: inv, onSuccess: () => refetch() });
  const receiveM = useAction(() => post(`/stock-transfers/${id}/receive`, { items: t.items.map((i: any) => ({ id: i.id, received_qty: Number(qty[i.id] ?? i.quantity) })), notes: notes || null }, true), { success: 'Transfer received', invalidate: inv, onSuccess: () => { setReceiving(false); refetch(); } });
  const cancelM = useAction((v: any) => post(`/stock-transfers/${id}/cancel`, v), { success: 'Cancelled', invalidate: inv, onSuccess: () => { setCancel(false); refetch(); } });
  if (!id) return null;
  return <Modal open={!!id} onOpenChange={(o) => !o && onClose()} title={t ? <span className="flex items-center gap-2">{t.number} <StatusBadge status={t.status} /></span> : 'Transfer'} size="lg">{t && <div className="space-y-4">
    <KV cols={3} items={[['Route', <span key="r" className="flex items-center gap-1">{t.from_store_name} <ArrowRight className="h-3 w-3" /> {t.to_store_name}</span>], ['Created', `${t.created_by_name} · ${fmtDateTime(t.created_at)}`], ['Received', t.received_by_name ? `${t.received_by_name} · ${fmtDateTime(t.completed_at)}` : '—'], ['Value', fmtMoney(t.value, currency)], ['Notes', t.notes ?? '—']]} />
    <LinesTable rows={t.items} columns={[{ key: 'product_name', label: 'Product', render: (i) => <div><div className="font-medium">{i.product_name}</div><div className="text-xs text-muted-foreground">{i.sku} · {i.unit}</div></div> }, { key: 'quantity', label: 'Sent', align: 'right', render: (i) => fmtNum(i.quantity, 3) }, { key: 'unit_cost', label: 'Unit cost', align: 'right', render: (i) => fmtMoney(i.unit_cost, currency) }, ...(receiving ? [{ key: 'received', label: 'Received', align: 'right' as const, render: (i: any) => <Input type="number" step="any" min={0} max={i.quantity} className="w-24 text-right ml-auto" value={qty[i.id] ?? i.quantity} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /> }] : [])]} />
    {receiving ? <div className="flex items-end gap-3"><div className="flex-1 flex flex-col gap-1"><Label>Notes (shortages are written off as transfer variance)</Label><Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} /></div><Button variant="ghost" onClick={() => setReceiving(false)}>Back</Button><Button loading={receiveM.isPending} onClick={() => receiveM.mutate(undefined as any)}><PackageCheck />Confirm receipt</Button></div>
      : <div className="flex flex-wrap gap-2">{t.status === 'DRAFT' && can('inventory.transfer') && <Button onClick={() => dispatchM.mutate(undefined as any)}><Truck />Dispatch</Button>}{t.status === 'IN_TRANSIT' && can('inventory.transfer', 'inventory.issue') && <Button onClick={() => setReceiving(true)}><PackageCheck />Receive…</Button>}{['DRAFT', 'IN_TRANSIT'].includes(t.status) && can('inventory.transfer') && <Button variant="ghost" onClick={() => setCancel(true)}>Cancel transfer</Button>}</div>}
    <AuditTrail entity="stock_transfer" entityId={id} />
    <ConfirmDialog open={cancel} onOpenChange={setCancel} title="Cancel transfer" description="In-transit stock is returned to the source store." destructive confirmLabel="Cancel transfer" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => cancelM.mutateAsync(v)} />
  </div>}</Modal>;
}
export default function TransfersPage() {
  const { can } = useAuth(); const [open, setOpen] = useState(false); const [sel, setSel] = useState<string | null>(null);
  return <div className="space-y-4">
    <PageHeader title="Stock transfers" subtitle="Move stock between stores (e.g. main store → pool bar). Stock leaves on dispatch and arrives on receipt." actions={can('inventory.transfer') && <Button onClick={() => setOpen(true)}><Plus />New transfer</Button>} />
    <DataTable path="/stock-transfers" defaultSort="created_at" onRowClick={(r) => setSel(r.id)} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['DRAFT', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'] }, { key: 'from_store_id', label: 'From', type: 'select', source: '/stores' }, { key: 'to_store_id', label: 'To', type: 'select', source: '/stores' }]}
      columns={[{ key: 'number', label: 'No.' }, { key: 'created_at', label: 'Date', type: 'datetime' }, { key: 'from_store_name', label: 'From' }, { key: 'to_store_name', label: 'To' }, { key: 'item_count', label: 'Lines', type: 'number', decimals: 0 }, { key: 'value', label: 'Value', type: 'money' }, { key: 'created_by_name', label: 'By' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
    <NewTransfer open={open} onOpenChange={setOpen} onCreated={(t) => setSel(t.id)} />
    <TransferDetail id={sel} onClose={() => setSel(null)} />
  </div>;
}
