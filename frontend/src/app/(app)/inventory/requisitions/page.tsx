'use client';
import React, { useState } from 'react';
import { Plus, Check, X, PackageCheck, Send } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { LookupSelect, ConfirmDialog } from '@/components/shared/form';
import { Switch } from '@/components/ui/misc';
import { ProductLines, LinesTable, type ProductLine } from '@/components/inventory/product-lines';
import { AuditTrail } from '@/components/shared/audit-trail';
import { fmtDateTime, fmtMoney, fmtNum, titleCase } from '@/lib/utils';

/** Requisition: a department/outlet (or another store) asks a store for stock. Flow: DRAFT → PENDING → APPROVED → (PARTIALLY_)ISSUED. */
function NewRequisition({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (r: any) => void }) {
  const [f, setF] = useState<any>({ store_id: '', target: 'DEPT', department_id: '', outlet_id: '', to_store_id: '', purpose: '', submit: true }); const [lines, setLines] = useState<ProductLine[]>([]);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const create = useAction(() => post('/requisitions', { store_id: f.store_id, department_id: f.target === 'DEPT' ? f.department_id || null : null, outlet_id: f.target === 'OUTLET' ? f.outlet_id || null : null, to_store_id: f.target === 'STORE' ? f.to_store_id || null : null, purpose: f.purpose || null, submit: f.submit, items: lines.map((l) => ({ product_id: l.product_id, requested_qty: Number(l.quantity), notes: l.notes || null })) }), { success: 'Requisition created', invalidate: ['/requisitions'], onSuccess: (r: any) => { onOpenChange(false); setLines([]); onCreated(r); } });
  return <Modal open={open} onOpenChange={onOpenChange} title="New stock requisition" size="xl"><div className="space-y-3">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="flex flex-col gap-1"><Label>Request from store</Label><LookupSelect source="/stores" value={f.store_id} onChange={(v) => { set('store_id', v); setLines([]); }} allowEmpty={false} placeholder="Select store" /></div>
      <div className="flex flex-col gap-1"><Label>Deliver to</Label><div className="flex h-9 rounded-md border p-0.5">{[['DEPT', 'Department'], ['OUTLET', 'Outlet'], ['STORE', 'Store']].map(([k, l]) => <button type="button" key={k} onClick={() => set('target', k)} className={`flex-1 rounded text-xs ${f.target === k ? 'bg-primary text-primary-foreground' : ''}`}>{l}</button>)}</div></div>
      {f.target === 'DEPT' && <div className="flex flex-col gap-1"><Label>Department</Label><LookupSelect source="/departments" value={f.department_id} onChange={(v) => set('department_id', v)} allowEmpty={false} placeholder="Select" /></div>}
      {f.target === 'OUTLET' && <div className="flex flex-col gap-1"><Label>Outlet</Label><LookupSelect source="/outlets" value={f.outlet_id} onChange={(v) => set('outlet_id', v)} allowEmpty={false} placeholder="Select" /></div>}
      {f.target === 'STORE' && <div className="flex flex-col gap-1"><Label>Receiving store</Label><LookupSelect source="/stores" value={f.to_store_id} onChange={(v) => set('to_store_id', v)} allowEmpty={false} placeholder="Select" /></div>}
      <div className="flex flex-col gap-1"><Label>Purpose</Label><Input value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="Weekly housekeeping supplies" /></div>
    </div>
    {f.store_id ? <ProductLines lines={lines} onChange={setLines} storeId={f.store_id} qtyLabel="Requested" showCost allowNotes /> : <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">Select the source store first.</div>}
    <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-sm"><Switch checked={f.submit} onCheckedChange={(v) => set('submit', v)} /> Submit for approval now (otherwise saved as draft)</label><Button loading={create.isPending} disabled={!f.store_id || lines.length === 0 || (f.target === 'DEPT' && !f.department_id) || (f.target === 'OUTLET' && !f.outlet_id) || (f.target === 'STORE' && !f.to_store_id)} onClick={() => create.mutate(undefined as any)}><Send />{f.submit ? 'Submit requisition' : 'Save draft'}</Button></div>
  </div></Modal>;
}
function RequisitionDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, currency } = useAuth(); const { data: q, refetch } = useApi<any>(id ? `/requisitions/${id}` : null);
  const [mode, setMode] = useState<'view' | 'approve' | 'issue'>('view'); const [qty, setQty] = useState<Record<string, string>>({}); const [notes, setNotes] = useState(''); const [reject, setReject] = useState(false); const [cancel, setCancel] = useState(false);
  const inv = ['/requisitions', '/stock', '/approvals'];
  const done = () => { setMode('view'); setQty({}); setNotes(''); refetch(); };
  const submitM = useAction(() => post(`/requisitions/${id}/submit`), { success: 'Submitted for approval', invalidate: inv, onSuccess: done });
  const approveM = useAction(() => post(`/requisitions/${id}/approve`, { items: q.items.map((i: any) => ({ id: i.id, approved_qty: Number(qty[i.id] ?? i.requested_qty) })), notes: notes || null }), { success: 'Requisition approved', invalidate: inv, onSuccess: done });
  const rejectM = useAction((v: any) => post(`/requisitions/${id}/reject`, v), { success: 'Rejected', invalidate: inv, onSuccess: () => { setReject(false); done(); } });
  const issueM = useAction(() => post(`/requisitions/${id}/issue`, { items: q.items.map((i: any) => ({ id: i.id, quantity: Number(qty[i.id] ?? Math.max(0, Number(i.approved_qty ?? i.requested_qty) - Number(i.issued_qty))) })), notes: notes || null }, true), { success: 'Stock issued', invalidate: inv, onSuccess: done });
  const cancelM = useAction((v: any) => post(`/requisitions/${id}/cancel`, v), { success: 'Cancelled', invalidate: inv, onSuccess: () => { setCancel(false); done(); } });
  if (!id) return null;
  const remaining = (i: any) => Math.max(0, Number(i.approved_qty ?? i.requested_qty) - Number(i.issued_qty ?? 0));
  return <Modal open={!!id} onOpenChange={(o) => !o && onClose()} title={q ? <span className="flex items-center gap-2">{q.number} <StatusBadge status={q.status} /></span> : 'Requisition'} size="xl">{q && <div className="space-y-4">
    <KV cols={4} items={[['From store', q.store_name], ['Deliver to', q.to_store_name ?? q.department_name ?? q.outlet_name ?? '—'], ['Requested by', `${q.requested_by_name} · ${fmtDateTime(q.created_at)}`], ['Approved by', q.approved_by_name ? `${q.approved_by_name} · ${fmtDateTime(q.approved_at)}` : '—'], ['Purpose', q.purpose ?? '—'], ['Estimated value', fmtMoney(q.estimated_value, currency)]]} />
    <LinesTable rows={q.items} columns={[{ key: 'product_name', label: 'Product', render: (i) => <div><div className="font-medium">{i.product_name}</div><div className="text-xs text-muted-foreground">{i.sku} · {i.unit}{i.notes ? ` · ${i.notes}` : ''}</div></div> }, { key: 'available', label: 'On hand', align: 'right', render: (i) => <span className={Number(i.available) < Number(i.requested_qty) ? 'text-destructive' : ''}>{fmtNum(i.available, 3)}</span> }, { key: 'requested_qty', label: 'Requested', align: 'right', render: (i) => fmtNum(i.requested_qty, 3) }, { key: 'approved_qty', label: 'Approved', align: 'right', render: (i) => (mode === 'approve' ? <Input type="number" step="any" min={0} className="w-24 text-right ml-auto" value={qty[i.id] ?? i.requested_qty} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /> : i.approved_qty == null ? '—' : fmtNum(i.approved_qty, 3)) }, { key: 'issued_qty', label: mode === 'issue' ? 'Issue now' : 'Issued', align: 'right', render: (i) => (mode === 'issue' ? <Input type="number" step="any" min={0} max={Math.min(remaining(i), Number(i.available))} className="w-24 text-right ml-auto" value={qty[i.id] ?? Math.min(remaining(i), Number(i.available))} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /> : fmtNum(i.issued_qty ?? 0, 3)) }]} />
    {mode !== 'view' && <div className="flex items-end gap-3"><div className="flex-1 flex flex-col gap-1"><Label>Notes</Label><Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} /></div><Button variant="ghost" onClick={() => setMode('view')}>Back</Button>{mode === 'approve' ? <Button loading={approveM.isPending} onClick={() => approveM.mutate(undefined as any)}><Check />Approve</Button> : <Button loading={issueM.isPending} onClick={() => issueM.mutate(undefined as any)}><PackageCheck />Issue stock</Button>}</div>}
    {mode === 'view' && <div className="flex flex-wrap gap-2">
      {q.status === 'DRAFT' && can('requisitions.create') && <Button onClick={() => submitM.mutate(undefined as any)}><Send />Submit</Button>}
      {['PENDING', 'DRAFT'].includes(q.status) && can('requisitions.approve') && <><Button onClick={() => setMode('approve')}><Check />Approve…</Button><Button variant="outline" onClick={() => setReject(true)}><X />Reject</Button></>}
      {['APPROVED', 'PARTIALLY_ISSUED'].includes(q.status) && can('inventory.issue') && <Button onClick={() => setMode('issue')}><PackageCheck />Issue…</Button>}
      {['DRAFT', 'PENDING', 'APPROVED'].includes(q.status) && can('requisitions.create') && <Button variant="ghost" onClick={() => setCancel(true)}>Cancel requisition</Button>}
    </div>}
    {q.movements?.length > 0 && <Section title="Stock movements"><ul className="divide-y text-sm">{q.movements.map((m: any) => <li key={m.id} className="flex justify-between py-1"><span>{fmtDateTime(m.created_at)} · {m.product_name} · {m.store_name}</span><span className="tabular">{fmtNum(m.quantity, 3)} @ {fmtMoney(m.unit_cost, currency)}</span></li>)}</ul></Section>}
    <AuditTrail entity="stock_requisition" entityId={id} />
    <ConfirmDialog open={reject} onOpenChange={setReject} title="Reject requisition" destructive confirmLabel="Reject" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => rejectM.mutateAsync(v)} />
    <ConfirmDialog open={cancel} onOpenChange={setCancel} title="Cancel requisition" destructive confirmLabel="Cancel requisition" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => cancelM.mutateAsync(v)} />
  </div>}</Modal>;
}
export default function RequisitionsPage() {
  const { can } = useAuth(); const [open, setOpen] = useState(false); const [sel, setSel] = useState<string | null>(null);
  return <div className="space-y-4">
    <PageHeader title="Stock requisitions" subtitle="Departments and outlets request stock from stores; approvers release it; storekeepers issue against the approved quantities." actions={can('requisitions.create') && <Button onClick={() => setOpen(true)}><Plus />New requisition</Button>} />
    <DataTable path="/requisitions" defaultSort="created_at" onRowClick={(r) => setSel(r.id)} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['DRAFT', 'PENDING', 'APPROVED', 'PARTIALLY_ISSUED', 'ISSUED', 'REJECTED', 'CANCELLED'] }, { key: 'store_id', label: 'Store', type: 'select', source: '/stores' }, { key: 'department_id', label: 'Department', type: 'select', source: '/departments' }]}
      columns={[{ key: 'number', label: 'No.' }, { key: 'created_at', label: 'Date', type: 'datetime' }, { key: 'store_name', label: 'From store' }, { key: 'department_name', label: 'To', render: (r) => r.to_store_name ?? r.department_name ?? r.outlet_name ?? '—' }, { key: 'purpose', label: 'Purpose' }, { key: 'item_count', label: 'Lines', type: 'number', decimals: 0 }, { key: 'estimated_value', label: 'Est. value', type: 'money' }, { key: 'requested_by_name', label: 'Requested by' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
    <NewRequisition open={open} onOpenChange={setOpen} onCreated={(r) => setSel(r.id)} />
    <RequisitionDetail id={sel} onClose={() => setSel(null)} />
  </div>;
}
