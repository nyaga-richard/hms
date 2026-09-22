'use client';
import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Check, X, Send, Mail, PackageCheck, Lock, Printer } from 'lucide-react';
import { post, get } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, KV, Section } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { LookupSelect, ConfirmDialog } from '@/components/shared/form';
import { Switch } from '@/components/ui/misc';
import { ProductLines, LinesTable, type ProductLine } from '@/components/inventory/product-lines';
import { ApprovalTrail } from '@/components/shared/approval-trail';
import { AuditTrail } from '@/components/shared/audit-trail';
import { Attachments } from '@/components/shared/attachments';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, today, addDays } from '@/lib/utils';

export const PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'REJECTED', 'CANCELLED'];
/** PO wizard-lite: header → lines (prefilled from an approved requisition or a selected quotation) → submit. */
function NewPO({ open, onOpenChange, onCreated, preset }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (po: any) => void; preset: { requisition_id?: string; quotation_id?: string; supplier_id?: string } }) {
  const { currency } = useAuth();
  const [f, setF] = useState<any>({ supplier_id: preset.supplier_id ?? '', requisition_id: preset.requisition_id ?? '', quotation_id: preset.quotation_id ?? '', store_id: '', order_date: today(), expected_date: addDays(today(), 3), payment_terms: '', delivery_address: '', notes: '', is_cash_purchase: false, submit: true });
  const [lines, setLines] = useState<ProductLine[]>([]); const [taxId, setTaxId] = useState(''); const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  useEffect(() => { (async () => {
    if (preset.quotation_id) { const q = await get(`/quotations/${preset.quotation_id}`); setF((x: any) => ({ ...x, supplier_id: q.supplier_id, requisition_id: q.requisition_id ?? x.requisition_id })); setLines((q.items ?? []).map((i: any) => ({ product_id: i.product_id ?? `free:${i.id}`, name: i.product_name ?? i.description, sku: i.sku, quantity: i.quantity, avg_cost: Number(i.unit_price) }))); }
    else if (preset.requisition_id) { const pr = await get(`/purchase-requisitions/${preset.requisition_id}`); setF((x: any) => ({ ...x, store_id: pr.store_id ?? '', supplier_id: x.supplier_id || pr.items?.find((i: any) => i.preferred_supplier_id)?.preferred_supplier_id || '' })); setLines((pr.items ?? []).map((i: any) => ({ product_id: i.product_id ?? `free:${i.id}`, name: i.product_name ?? i.description, sku: i.sku, unit: i.unit, quantity: i.quantity, avg_cost: Number(i.estimated_unit_cost) }))); }
  })(); }, [preset.quotation_id, preset.requisition_id]);
  const { data: sup } = useApi<any>(f.supplier_id ? `/suppliers/${f.supplier_id}` : null);
  useEffect(() => { if (sup && !f.payment_terms) set('payment_terms', `${sup.payment_terms_days} days`); }, [sup]); // eslint-disable-line react-hooks/exhaustive-deps
  const subtotal = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.avg_cost || 0), 0);
  const create = useAction(() => post('/purchase-orders', { ...f, requisition_id: f.requisition_id || null, quotation_id: f.quotation_id || null, store_id: f.store_id || null, payment_terms: f.payment_terms || null, delivery_address: f.delivery_address || null, notes: f.notes || null, items: lines.map((l) => ({ product_id: l.product_id.startsWith('free:') ? null : l.product_id, description: l.product_id.startsWith('free:') ? l.name : null, quantity: Number(l.quantity), unit_price: Number(l.avg_cost ?? 0), tax_id: taxId || null })) }, true), { success: 'Purchase order created', invalidate: ['/purchase-orders', '/purchase-requisitions', '/approvals'], onSuccess: (po: any) => { onOpenChange(false); onCreated(po); } });
  return <Modal open={open} onOpenChange={onOpenChange} title="New purchase order" size="xl"><div className="space-y-3">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="flex flex-col gap-1 col-span-2"><Label>Supplier</Label><LookupSelect source="/suppliers" value={f.supplier_id} onChange={(v) => set('supplier_id', v)} allowEmpty={false} placeholder="Select supplier" /></div>
      <div className="flex flex-col gap-1"><Label>Deliver to store</Label><LookupSelect source="/stores" value={f.store_id} onChange={(v) => set('store_id', v)} placeholder="Main store" /></div>
      <div className="flex flex-col gap-1"><Label>Tax on lines</Label><LookupSelect source="/taxes" value={taxId} onChange={setTaxId} placeholder="No tax" /></div>
      <div className="flex flex-col gap-1"><Label>Order date</Label><Input type="date" value={f.order_date} onChange={(e) => set('order_date', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Expected delivery</Label><Input type="date" value={f.expected_date} onChange={(e) => set('expected_date', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Payment terms</Label><Input value={f.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} placeholder="30 days" /></div>
      <div className="flex flex-col gap-1"><Label>Requisition</Label><Input value={f.requisition_id ? 'Linked' : 'None'} readOnly className="text-muted-foreground" /></div>
      <div className="flex flex-col gap-1 col-span-2"><Label>Delivery address / instructions</Label><Input value={f.delivery_address} onChange={(e) => set('delivery_address', e.target.value)} /></div>
      <div className="flex flex-col gap-1 col-span-2"><Label>Notes to supplier</Label><Input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
    </div>
    <ProductLines lines={lines} onChange={setLines} storeId={f.store_id || null} qtyLabel="Order qty" stockOnly={false} showCost extraColumn={{ label: 'Unit price', render: (l, setL) => <Input type="number" step="0.01" className="text-right" value={l.avg_cost ?? ''} onChange={(e) => setL({ avg_cost: Number(e.target.value) })} /> }} />
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-4 text-sm"><label className="flex items-center gap-2"><Switch checked={f.is_cash_purchase} onCheckedChange={(v) => set('is_cash_purchase', v)} /> Cash purchase (petty cash / pay on delivery)</label><label className="flex items-center gap-2"><Switch checked={f.submit} onCheckedChange={(v) => set('submit', v)} /> Submit for approval</label></div><div className="flex items-center gap-3"><span className="text-sm">Subtotal <b>{fmtMoney(subtotal, currency)}</b></span><Button loading={create.isPending} disabled={!f.supplier_id || lines.length === 0} onClick={() => create.mutate(undefined as any)}><Send />{f.submit ? 'Submit PO' : 'Save draft'}</Button></div></div>
  </div></Modal>;
}
export function PODetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, currency } = useAuth(); const router = useRouter(); const { data: po, refetch } = useApi<any>(id ? `/purchase-orders/${id}` : null);
  const [reject, setReject] = useState(false); const [cancel, setCancel] = useState(false); const [close, setClose] = useState(false);
  const inv = ['/purchase-orders', '/approvals', '/purchase-requisitions'];
  const useAct = (path: string, msg: string) => useAction((v: any) => post(`/purchase-orders/${id}/${path}`, v ?? {}), { success: msg, invalidate: inv, onSuccess: () => { setReject(false); setCancel(false); setClose(false); refetch(); } });
  const submitM = useAct('submit', 'Submitted for approval'); const approveM = useAct('approve', 'Approved'); const rejectM = useAct('reject', 'Rejected'); const sendM = useAct('send', 'Marked as sent to supplier'); const closeM = useAct('close', 'PO closed'); const cancelM = useAct('cancel', 'PO cancelled');
  if (!id) return null;
  return <Modal open={!!id} onOpenChange={(o) => !o && onClose()} title={po ? <span className="flex items-center gap-2">{po.number} <StatusBadge status={po.status} />{po.is_cash_purchase && <Badge tone="info">Cash purchase</Badge>}</span> : 'Purchase order'} size="xl">{po && <div className="space-y-4">
    <KV cols={4} items={[['Supplier', <span key="s">{po.supplier_name}<div className="text-xs text-muted-foreground">{[po.supplier_phone, po.supplier_email].filter(Boolean).join(' · ')}</div></span>], ['Deliver to', po.store_name ?? '—'], ['Order date', fmtDate(po.order_date)], ['Expected', fmtDate(po.expected_date)], ['Requisition', po.requisition_number ?? '—'], ['Terms', po.payment_terms ?? '—'], ['Created', `${po.created_by_name} · ${fmtDateTime(po.created_at)}`], ['Approved', po.approved_by_name ? `${po.approved_by_name} · ${fmtDateTime(po.approved_at)}` : '—'], ['Subtotal', fmtMoney(po.subtotal, currency)], ['Tax', fmtMoney(po.tax_total, currency)], ['Total', <b key="t">{fmtMoney(po.total, currency)}</b>], ['Received', `${fmtNum(po.received_total_qty ?? 0, 2)} / ${fmtNum(po.ordered_total_qty ?? 0, 2)} units`]]} />
    <LinesTable rows={po.items} columns={[{ key: 'product_name', label: 'Item', render: (i) => <div><div className="font-medium">{i.product_name ?? i.description}</div><div className="text-xs text-muted-foreground">{i.sku}{i.tax_name ? ` · ${i.tax_name}` : ''}</div></div> }, { key: 'quantity', label: 'Ordered', align: 'right', render: (i) => `${fmtNum(i.quantity, 2)} ${i.unit ?? ''}` }, { key: 'received_qty', label: 'Received', align: 'right', render: (i) => <span className={Number(i.outstanding_qty) > 0 && ['SENT', 'PARTIALLY_RECEIVED'].includes(po.status) ? 'text-amber-600' : ''}>{fmtNum(i.received_qty, 2)}</span> }, { key: 'invoiced_qty', label: 'Invoiced', align: 'right', render: (i) => fmtNum(i.invoiced_qty, 2) }, { key: 'unit_price', label: 'Unit price', align: 'right', render: (i) => fmtMoney(i.unit_price, currency) }, { key: 'tax_amount', label: 'Tax', align: 'right', render: (i) => fmtMoney(i.tax_amount, currency) }, { key: 'line_total', label: 'Total', align: 'right', render: (i) => fmtMoney(i.line_total, currency) }]} />
    <div className="flex flex-wrap gap-2">
      {po.status === 'DRAFT' && can('purchases.create') && <Button onClick={() => submitM.mutate(undefined)}><Send />Submit for approval</Button>}
      {['PENDING_APPROVAL', 'DRAFT'].includes(po.status) && can('purchases.approve') && <><Button onClick={() => approveM.mutate(undefined)}><Check />Approve</Button><Button variant="outline" onClick={() => setReject(true)}><X />Reject</Button></>}
      {po.status === 'APPROVED' && can('purchases.create') && <Button onClick={() => sendM.mutate(undefined)}><Mail />Mark sent to supplier</Button>}
      {['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status) && can('purchases.receive') && <Button onClick={() => router.push(`/procurement/grns?new=1&po=${po.id}`)}><PackageCheck />Receive goods</Button>}
      {['RECEIVED', 'PARTIALLY_RECEIVED'].includes(po.status) && can('purchases.invoice') && <Button variant="outline" onClick={() => router.push(`/procurement/supplier-invoices?new=1&po=${po.id}`)}>Record supplier invoice</Button>}
      {['APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status) && can('purchases.approve', 'purchases.create') && <Button variant="ghost" onClick={() => setClose(true)}><Lock />Close PO</Button>}
      {['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(po.status) && can('purchases.create') && <Button variant="ghost" onClick={() => setCancel(true)}>Cancel</Button>}
      <Button variant="ghost" onClick={() => window.print()}><Printer />Print</Button>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Goods received"><ul className="divide-y text-sm">{(po.grns ?? []).map((g: any) => <li key={g.id} className="flex justify-between py-1"><a className="underline" href={`/procurement/grns?id=${g.id}`}>{g.number}</a><span>{fmtDate(g.received_date)} · {g.received_by_name} · {fmtMoney(g.total_value, currency)} <StatusBadge status={g.status} /></span></li>)}{(po.grns ?? []).length === 0 && <li className="py-2 text-muted-foreground">Nothing received yet.</li>}</ul></Section>
      <Section title="Supplier invoices"><ul className="divide-y text-sm">{(po.invoices ?? []).map((i: any) => <li key={i.id} className="flex justify-between py-1"><a className="underline" href={`/procurement/supplier-invoices?id=${i.id}`}>{i.number} · {i.supplier_invoice_no}</a><span>{fmtMoney(i.total, currency)} · bal {fmtMoney(i.balance, currency)} <StatusBadge status={i.status} /></span></li>)}{(po.invoices ?? []).length === 0 && <li className="py-2 text-muted-foreground">No invoices.</li>}</ul></Section>
    </div>
    {po.notes && <div className="text-sm"><span className="text-muted-foreground">Notes:</span> {po.notes}</div>}
    <ApprovalTrail approval={po.approval} />
    <Attachments entity="purchase_order" entityId={id} title="Quotes, supplier confirmations" />
    <AuditTrail entity="purchase_order" entityId={id} />
    <ConfirmDialog open={reject} onOpenChange={setReject} title="Reject purchase order" destructive confirmLabel="Reject" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => rejectM.mutateAsync(v)} />
    <ConfirmDialog open={cancel} onOpenChange={setCancel} title="Cancel purchase order" destructive confirmLabel="Cancel PO" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => cancelM.mutateAsync(v)} />
    <ConfirmDialog open={close} onOpenChange={setClose} title="Close purchase order" description="Outstanding quantities will no longer be expected. Use this for short deliveries you accept." confirmLabel="Close PO" fields={[{ name: 'reason', label: 'Reason' }]} onConfirm={(v) => closeM.mutateAsync(v)} />
  </div>}</Modal>;
}
function PurchaseOrdersPageInner() {
  const { can } = useAuth(); const sp = useSearchParams(); const router = useRouter();
  const [open, setOpen] = useState(false); const [sel, setSel] = useState<string | null>(null); const [preset, setPreset] = useState<any>({});
  useEffect(() => { if (sp.get('new')) { setPreset({ requisition_id: sp.get('requisition_id') ?? undefined, quotation_id: sp.get('quotation_id') ?? undefined, supplier_id: sp.get('supplier_id') ?? undefined }); setOpen(true); } if (sp.get('id')) setSel(sp.get('id')); }, [sp]);
  return <div className="space-y-4">
    <PageHeader title="Purchase orders" subtitle="Approved orders sent to suppliers. Receiving posts stock and GRN accruals; invoices are 3-way matched to PO and GRN." actions={can('purchases.create') && <Button onClick={() => { setPreset({}); setOpen(true); }}><Plus />New purchase order</Button>} />
    <DataTable path="/purchase-orders" defaultSort="created_at" onRowClick={(r) => setSel(r.id)} filters={[{ key: 'status', label: 'Status', type: 'select', options: PO_STATUSES }, { key: 'supplier_id', label: 'Supplier', type: 'select', source: '/suppliers' }, { key: 'store_id', label: 'Store', type: 'select', source: '/stores' }]}
      columns={[{ key: 'number', label: 'PO' }, { key: 'order_date', label: 'Date', type: 'date' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'store_name', label: 'Store' }, { key: 'expected_date', label: 'Expected', type: 'date' }, { key: 'item_count', label: 'Lines', type: 'number', decimals: 0 }, { key: 'total', label: 'Total', type: 'money' }, { key: 'received_total_qty', label: 'Received', render: (r) => <span className="tabular">{fmtNum(r.received_total_qty ?? 0, 0)}/{fmtNum(r.ordered_total_qty ?? 0, 0)}</span> }, { key: 'grn_count', label: 'GRNs', type: 'number', decimals: 0 }, { key: 'invoice_count', label: 'Invoices', type: 'number', decimals: 0 }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
    {open && <NewPO open={open} onOpenChange={(o) => { setOpen(o); if (!o) router.replace('/procurement/purchase-orders'); }} preset={preset} onCreated={(po) => setSel(po.id)} />}
    <PODetail id={sel} onClose={() => { setSel(null); if (sp.get('id')) router.replace('/procurement/purchase-orders'); }} />
  </div>;
}
export function PurchaseOrdersPage() { return <Suspense fallback={null}><PurchaseOrdersPageInner /></Suspense>; }
