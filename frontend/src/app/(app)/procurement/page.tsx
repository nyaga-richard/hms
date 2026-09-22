'use client';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Check, X, Send, ShoppingCart, Scale } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, KV, Section } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { LookupSelect, ConfirmDialog, FormDialog } from '@/components/shared/form';
import { Switch } from '@/components/ui/misc';
import { ProductLines, LinesTable, type ProductLine } from '@/components/inventory/product-lines';
import { ApprovalTrail } from '@/components/shared/approval-trail';
import { AuditTrail } from '@/components/shared/audit-trail';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, titleCase, today, addDays } from '@/lib/utils';

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
/** Purchase requisition: what a department needs bought. Approved PRs feed quotations & POs. */
function NewPR({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (r: any) => void }) {
  const [f, setF] = useState<any>({ department_id: '', store_id: '', required_by: addDays(today(), 7), priority: 'NORMAL', justification: '', submit: true }); const [lines, setLines] = useState<ProductLine[]>([]);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const create = useAction(() => post('/purchase-requisitions', { ...f, department_id: f.department_id || null, store_id: f.store_id || null, justification: f.justification || null, items: lines.map((l) => ({ product_id: l.product_id.startsWith('free:') ? null : l.product_id, description: l.product_id.startsWith('free:') ? l.name : null, quantity: Number(l.quantity), estimated_unit_cost: Number(l.extra?.est ?? l.avg_cost ?? 0), notes: l.notes || null })) }), { success: 'Purchase requisition created', invalidate: ['/purchase-requisitions', '/approvals'], onSuccess: (r: any) => { onOpenChange(false); setLines([]); onCreated(r); } });
  const [free, setFree] = useState('');
  return <Modal open={open} onOpenChange={onOpenChange} title="New purchase requisition" size="xl"><div className="space-y-3">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="flex flex-col gap-1"><Label>Department</Label><LookupSelect source="/departments" value={f.department_id} onChange={(v) => set('department_id', v)} placeholder="Select" /></div>
      <div className="flex flex-col gap-1"><Label>Deliver to store</Label><LookupSelect source="/stores" value={f.store_id} onChange={(v) => set('store_id', v)} placeholder="Main store" /></div>
      <div className="flex flex-col gap-1"><Label>Required by</Label><Input type="date" value={f.required_by} onChange={(e) => set('required_by', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Priority</Label><NativeSelect value={f.priority} onChange={(e) => set('priority', e.target.value)}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</NativeSelect></div>
      <div className="flex flex-col gap-1 col-span-4"><Label>Justification</Label><Textarea rows={2} value={f.justification} onChange={(e) => set('justification', e.target.value)} placeholder="Why is this purchase needed?" /></div>
    </div>
    <ProductLines lines={lines} onChange={setLines} storeId={f.store_id || null} qtyLabel="Quantity" showCost stockOnly={false} allowNotes extraColumn={{ label: 'Est. unit cost', render: (l, set) => <Input type="number" step="0.01" className="text-right" value={l.extra?.est ?? l.avg_cost ?? ''} onChange={(e) => set({ extra: { ...l.extra, est: e.target.value }, avg_cost: Number(e.target.value) })} /> }} />
    <div className="flex gap-2 items-center"><Input placeholder="Non-catalogue item (e.g. 'Generator service contract')" value={free} onChange={(e) => setFree(e.target.value)} /><Button variant="outline" disabled={!free.trim()} onClick={() => { setLines([...lines, { product_id: `free:${Date.now()}`, name: free.trim(), quantity: 1, avg_cost: 0 }]); setFree(''); }}>Add free-text line</Button></div>
    <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-sm"><Switch checked={f.submit} onCheckedChange={(v) => set('submit', v)} /> Submit for approval now</label><Button loading={create.isPending} disabled={lines.length === 0} onClick={() => create.mutate(undefined as any)}><Send />{f.submit ? 'Submit' : 'Save draft'}</Button></div>
  </div></Modal>;
}
function QuoteDialog({ pr, open, onOpenChange }: { pr: any; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [supplier, setSupplier] = useState(''); const [valid, setValid] = useState(addDays(today(), 14)); const [prices, setPrices] = useState<Record<string, string>>({}); const [lead, setLead] = useState<Record<string, string>>({});
  const create = useAction(() => post('/quotations', { requisition_id: pr.id, supplier_id: supplier, valid_until: valid, items: pr.items.map((i: any) => ({ product_id: i.product_id, description: i.description ?? i.product_name, quantity: Number(i.quantity), unit_price: Number(prices[i.id] ?? 0), lead_time_days: lead[i.id] ? Number(lead[i.id]) : null })) }), { success: 'Quotation recorded', invalidate: ['/purchase-requisitions', '/quotations'], onSuccess: () => onOpenChange(false) });
  const total = pr.items.reduce((s: number, i: any) => s + Number(i.quantity) * Number(prices[i.id] ?? 0), 0);
  return <Modal open={open} onOpenChange={onOpenChange} title={`Record supplier quotation · ${pr.number}`} size="lg"><div className="space-y-3">
    <div className="grid grid-cols-2 gap-3"><div className="flex flex-col gap-1"><Label>Supplier</Label><LookupSelect source="/suppliers" value={supplier} onChange={setSupplier} allowEmpty={false} placeholder="Select supplier" /></div><div className="flex flex-col gap-1"><Label>Valid until</Label><Input type="date" value={valid} onChange={(e) => setValid(e.target.value)} /></div></div>
    <table className="w-full text-sm"><thead className="text-xs uppercase text-muted-foreground"><tr><th className="text-left py-1">Item</th><th className="text-right">Qty</th><th className="text-right w-32">Unit price</th><th className="text-right w-24">Lead days</th><th className="text-right">Total</th></tr></thead><tbody className="divide-y">{pr.items.map((i: any) => <tr key={i.id}><td className="py-1">{i.product_name ?? i.description}</td><td className="text-right tabular">{fmtNum(i.quantity, 2)} {i.unit}</td><td className="p-1"><Input type="number" step="0.01" className="text-right" value={prices[i.id] ?? ''} onChange={(e) => setPrices({ ...prices, [i.id]: e.target.value })} /></td><td className="p-1"><Input type="number" className="text-right" value={lead[i.id] ?? ''} onChange={(e) => setLead({ ...lead, [i.id]: e.target.value })} /></td><td className="text-right tabular">{fmtNum(Number(i.quantity) * Number(prices[i.id] ?? 0), 2)}</td></tr>)}</tbody><tfoot><tr className="font-semibold"><td colSpan={4} className="py-2 text-right">Quote total</td><td className="text-right tabular">{fmtNum(total, 2)}</td></tr></tfoot></table>
    <div className="flex justify-end"><Button loading={create.isPending} disabled={!supplier} onClick={() => create.mutate(undefined as any)}>Save quotation</Button></div></div></Modal>;
}
function PRDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, currency } = useAuth(); const router = useRouter(); const { data: pr, refetch } = useApi<any>(id ? `/purchase-requisitions/${id}` : null); const { data: cmp } = useApi<any>(id && pr?.quotations?.length ? `/quotations/compare/${id}` : null);
  const [reject, setReject] = useState(false); const [cancel, setCancel] = useState(false); const [quote, setQuote] = useState(false);
  const inv = ['/purchase-requisitions', '/approvals'];
  const submitM = useAction(() => post(`/purchase-requisitions/${id}/submit`), { success: 'Submitted', invalidate: inv, onSuccess: () => refetch() });
  const approveM = useAction(() => post(`/purchase-requisitions/${id}/approve`, {}), { success: 'Approved', invalidate: inv, onSuccess: () => refetch() });
  const rejectM = useAction((v: any) => post(`/purchase-requisitions/${id}/reject`, v), { success: 'Rejected', invalidate: inv, onSuccess: () => { setReject(false); refetch(); } });
  const cancelM = useAction((v: any) => post(`/purchase-requisitions/${id}/cancel`, v), { success: 'Cancelled', invalidate: inv, onSuccess: () => { setCancel(false); refetch(); } });
  const selectQ = useAction((qid: string) => post(`/quotations/${qid}/select`, {}), { success: 'Quotation selected — now raise the purchase order', invalidate: [...inv, '/quotations'], onSuccess: (q: any) => { refetch(); router.push(`/procurement/purchase-orders?new=1&requisition_id=${pr.id}&quotation_id=${q.id}&supplier_id=${q.supplier_id}`); } });
  if (!id) return null;
  return <Modal open={!!id} onOpenChange={(o) => !o && onClose()} title={pr ? <span className="flex items-center gap-2">{pr.number} <Badge tone={pr.priority === 'URGENT' ? 'destructive' : pr.priority === 'HIGH' ? 'warning' : 'muted'}>{pr.priority}</Badge> <StatusBadge status={pr.status} /></span> : 'Purchase requisition'} size="xl">{pr && <div className="space-y-4">
    <KV cols={4} items={[['Department', pr.department_name ?? '—'], ['Deliver to', pr.store_name ?? '—'], ['Required by', fmtDate(pr.required_by)], ['Requested', `${pr.requested_by_name} · ${fmtDateTime(pr.created_at)}`], ['Approved', pr.approved_by_name ? `${pr.approved_by_name} · ${fmtDateTime(pr.approved_at)}` : '—'], ['Estimated total', fmtMoney(pr.estimated_total ?? pr.total, currency)], ['Justification', pr.justification ?? '—']]} />
    <LinesTable rows={pr.items} columns={[{ key: 'product_name', label: 'Item', render: (i) => <div><div className="font-medium">{i.product_name ?? i.description}</div><div className="text-xs text-muted-foreground">{i.sku}{i.notes ? ` · ${i.notes}` : ''}</div></div> }, { key: 'on_hand', label: 'On hand (all stores)', align: 'right', render: (i) => (i.product_id ? fmtNum(i.on_hand, 2) : '—') }, { key: 'quantity', label: 'Qty', align: 'right', render: (i) => `${fmtNum(i.quantity, 2)} ${i.unit ?? ''}` }, { key: 'estimated_unit_cost', label: 'Est. unit cost', align: 'right', render: (i) => fmtMoney(i.estimated_unit_cost, currency) }, { key: 'total', label: 'Est. total', align: 'right', render: (i) => fmtMoney(Number(i.quantity) * Number(i.estimated_unit_cost), currency) }]} />
    <div className="flex flex-wrap gap-2">
      {pr.status === 'DRAFT' && can('requisitions.create') && <Button onClick={() => submitM.mutate(undefined as any)}><Send />Submit</Button>}
      {['PENDING', 'PENDING_APPROVAL'].includes(pr.status) && can('requisitions.approve') && <><Button onClick={() => approveM.mutate(undefined as any)}><Check />Approve</Button><Button variant="outline" onClick={() => setReject(true)}><X />Reject</Button></>}
      {pr.status === 'APPROVED' && can('purchases.quotations', 'purchases.create') && <Button variant="outline" onClick={() => setQuote(true)}><Scale />Record quotation</Button>}
      {pr.status === 'APPROVED' && can('purchases.create') && <Button onClick={() => router.push(`/procurement/purchase-orders?new=1&requisition_id=${pr.id}`)}><ShoppingCart />Create purchase order</Button>}
      {['DRAFT', 'PENDING', 'PENDING_APPROVAL', 'APPROVED'].includes(pr.status) && can('requisitions.create') && <Button variant="ghost" onClick={() => setCancel(true)}>Cancel</Button>}
    </div>
    {pr.quotations?.length > 0 && <Section title="Quotation comparison" description="Lowest total first. Selecting a quotation drafts a purchase order for that supplier."><table className="w-full text-sm"><thead className="text-xs uppercase text-muted-foreground"><tr><th className="text-left py-1">Supplier</th><th className="text-left">Valid until</th><th className="text-right">Total</th><th className="text-left">Terms</th><th className="text-left">Status</th><th /></tr></thead><tbody className="divide-y">{(cmp ?? pr.quotations).map((q: any, idx: number) => <tr key={q.id} className={idx === 0 ? 'bg-emerald-500/5' : ''}><td className="py-1.5 font-medium">{q.supplier_name}{q.rating ? <span className="text-xs text-amber-500 ml-1">{'★'.repeat(q.rating)}</span> : null}</td><td>{fmtDate(q.valid_until)}</td><td className="text-right tabular font-semibold">{fmtMoney(q.total, currency)}</td><td>{q.payment_terms_days != null ? `${q.payment_terms_days} days` : '—'}</td><td><StatusBadge status={q.status} /></td><td className="text-right">{q.status !== 'SELECTED' && pr.status === 'APPROVED' && can('purchases.create') && <Button size="sm" onClick={() => selectQ.mutate(q.id)}>Select</Button>}</td></tr>)}</tbody></table></Section>}
    {pr.purchase_orders?.length > 0 && <Section title="Purchase orders"><ul className="divide-y text-sm">{pr.purchase_orders.map((po: any) => <li key={po.id} className="flex justify-between py-1"><a className="underline" href={`/procurement/purchase-orders?id=${po.id}`}>{po.number}</a><span>{po.supplier_name} · {fmtMoney(po.total, currency)} <StatusBadge status={po.status} /></span></li>)}</ul></Section>}
    <ApprovalTrail approval={pr.approval} />
    <AuditTrail entity="purchase_requisition" entityId={id} />
    {quote && <QuoteDialog pr={pr} open={quote} onOpenChange={setQuote} />}
    <ConfirmDialog open={reject} onOpenChange={setReject} title="Reject requisition" destructive confirmLabel="Reject" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => rejectM.mutateAsync(v)} />
    <ConfirmDialog open={cancel} onOpenChange={setCancel} title="Cancel requisition" destructive confirmLabel="Cancel requisition" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => cancelM.mutateAsync(v)} />
  </div>}</Modal>;
}
export default function PurchaseRequisitionsPage() {
  const { can } = useAuth(); const [open, setOpen] = useState(false); const [sel, setSel] = useState<string | null>(null);
  return <div className="space-y-4">
    <PageHeader title="Purchase requisitions" subtitle="Requisition → approval → quotations → purchase order → goods received → supplier invoice → payment." actions={can('requisitions.create') && <Button onClick={() => setOpen(true)}><Plus />New requisition</Button>} />
    <DataTable path="/purchase-requisitions" defaultSort="created_at" onRowClick={(r) => setSel(r.id)} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['DRAFT', 'PENDING', 'APPROVED', 'ORDERED', 'REJECTED', 'CANCELLED'] }, { key: 'priority', label: 'Priority', type: 'select', options: PRIORITIES }, { key: 'department_id', label: 'Department', type: 'select', source: '/departments' }]}
      columns={[{ key: 'number', label: 'No.' }, { key: 'created_at', label: 'Date', type: 'datetime' }, { key: 'department_name', label: 'Department' }, { key: 'required_by', label: 'Required by', type: 'date' }, { key: 'priority', label: 'Priority', render: (r) => <Badge tone={r.priority === 'URGENT' ? 'destructive' : r.priority === 'HIGH' ? 'warning' : 'muted'}>{r.priority}</Badge> }, { key: 'item_count', label: 'Lines', type: 'number', decimals: 0 }, { key: 'estimated_total', label: 'Est. total', type: 'money' }, { key: 'po_count', label: 'POs', type: 'number', decimals: 0 }, { key: 'requested_by_name', label: 'By' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
    <NewPR open={open} onOpenChange={setOpen} onCreated={(r) => setSel(r.id)} />
    <PRDetail id={sel} onClose={() => setSel(null)} />
  </div>;
}
