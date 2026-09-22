'use client';
import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, Check, X, Wallet } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, KV, Section } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { LookupSelect, ConfirmDialog } from '@/components/shared/form';
import { PaymentLineFields, type PaymentLine } from '@/components/pms/payment-fields';
import { ApprovalTrail } from '@/components/shared/approval-trail';
import { AuditTrail } from '@/components/shared/audit-trail';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/utils';

/** Payment run for one supplier: pick open invoices, allocate amounts, choose bank/cash method. Requests above the approver's limit route to approval. */
function NewPayment({ open, onOpenChange, preset, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; preset: { supplier_id?: string | null; invoice_id?: string | null }; onCreated: (r: any) => void }) {
  const { currency } = useAuth(); const [supplier, setSupplier] = useState(preset.supplier_id ?? ''); const [alloc, setAlloc] = useState<Record<string, string>>({}); const [pay, setPay] = useState<PaymentLine>({ amount: '' }); const [notes, setNotes] = useState('');
  const { data: invoices } = useApi<any>(supplier ? '/supplier-invoices' : null, { supplier_id: supplier, unpaid: 'true', pageSize: 100, sort: 'due_date', order: 'asc' });
  useEffect(() => { if (preset.invoice_id && invoices?.data) { const i = invoices.data.find((x: any) => x.id === preset.invoice_id); if (i && alloc[i.id] === undefined) setAlloc({ [i.id]: String(i.balance) }); } }, [invoices, preset.invoice_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = Object.values(alloc).reduce((s, v) => s + Number(v || 0), 0);
  const create = useAction(() => post('/supplier-payments', { supplier_id: supplier, payment_method_id: pay.payment_method_id, reference: pay.reference || null, notes: notes || null, allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([invoice_id, amount]) => ({ invoice_id, amount: Number(amount) })) }, true), { success: (r: any) => (r.status === 'PAID' ? 'Payment posted' : 'Payment request submitted for approval'), invalidate: ['/supplier-payments', '/supplier-invoices', '/approvals', '/payments'], onSuccess: (r: any) => { onOpenChange(false); onCreated(r); } });
  return <Modal open={open} onOpenChange={onOpenChange} title="Pay supplier" size="lg"><div className="space-y-3">
    <div className="flex flex-col gap-1"><Label>Supplier</Label><LookupSelect source="/suppliers" value={supplier} onChange={(v) => { setSupplier(v); setAlloc({}); }} allowEmpty={false} placeholder="Select supplier" /></div>
    {supplier && <div className="rounded-md border overflow-hidden"><table className="w-full text-sm"><thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr><th className="p-2 text-left">Invoice</th><th className="p-2 text-left">Due</th><th className="p-2 text-right">Balance</th><th className="p-2 text-right w-36">Pay</th></tr></thead><tbody className="divide-y">{(invoices?.data ?? []).map((i: any) => <tr key={i.id}><td className="p-2">{i.number} <span className="text-xs text-muted-foreground">{i.supplier_invoice_no}</span></td><td className={`p-2 ${Number(i.days_overdue) > 0 ? 'text-destructive' : ''}`}>{fmtDate(i.due_date)}</td><td className="p-2 text-right tabular">{fmtMoney(i.balance, currency)}</td><td className="p-1"><div className="flex gap-1"><Input type="number" step="0.01" min={0} max={i.balance} className="text-right" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} /><Button size="sm" variant="ghost" onClick={() => setAlloc({ ...alloc, [i.id]: String(i.balance) })}>Full</Button></div></td></tr>)}{(invoices?.data ?? []).length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">No unpaid approved invoices for this supplier.</td></tr>}</tbody></table></div>}
    <PaymentLineFields value={{ ...pay, amount: String(total) }} onChange={setPay} showAmount={false} />
    <div className="flex flex-col gap-1"><Label>Notes</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
    <div className="flex items-center justify-between border-t pt-3"><span className="text-lg font-semibold">Total {fmtMoney(total, currency)}</span><Button loading={create.isPending} disabled={!supplier || total <= 0 || !pay.payment_method_id} onClick={() => create.mutate(undefined as any)}><Wallet />Submit payment</Button></div>
  </div></Modal>;
}
function PaymentDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, currency } = useAuth(); const { data: r, refetch } = useApi<any>(id ? `/supplier-payments/${id}` : null); const [reject, setReject] = useState(false);
  const inv = ['/supplier-payments', '/supplier-invoices', '/approvals', '/payments'];
  const approveM = useAction(() => post(`/supplier-payments/${id}/approve`, {}), { success: 'Payment approved & posted', invalidate: inv, onSuccess: () => refetch() });
  const rejectM = useAction((v: any) => post(`/supplier-payments/${id}/reject`, v), { success: 'Rejected', invalidate: inv, onSuccess: () => { setReject(false); refetch(); } });
  if (!id) return null;
  return <Modal open={!!id} onOpenChange={(o) => !o && onClose()} title={r ? <span className="flex items-center gap-2">Payment request <StatusBadge status={r.status} /></span> : 'Payment'} size="md">{r && <div className="space-y-4">
    <KV items={[['Supplier', r.supplier_name], ['Amount', <b key="a">{fmtMoney(r.amount, currency)}</b>], ['Method', r.method_name ?? '—'], ['Reference', r.reference ?? '—'], ['Requested', `${r.requested_by_name} · ${fmtDateTime(r.created_at)}`], ['Payment', r.payment_number ?? '—'], ['Notes', r.notes ?? '—']]} />
    <Section title="Allocations"><ul className="divide-y text-sm">{(r.invoices ?? []).map((i: any) => <li key={i.invoice_id} className="flex justify-between py-1"><span>{i.number} <span className="text-xs text-muted-foreground">{i.supplier_invoice_no}</span></span><span className="tabular">{fmtMoney(i.amount, currency)} <span className="text-xs text-muted-foreground">of {fmtMoney(i.total, currency)}</span></span></li>)}</ul></Section>
    {r.status === 'PENDING_APPROVAL' && can('payments.approve_supplier_payment') && <div className="flex gap-2"><Button loading={approveM.isPending} onClick={() => approveM.mutate(undefined as any)}><Check />Approve & pay</Button><Button variant="outline" onClick={() => setReject(true)}><X />Reject</Button></div>}
    <ApprovalTrail approval={r.approval} />
    <AuditTrail entity="supplier_payment_request" entityId={id} />
    <ConfirmDialog open={reject} onOpenChange={setReject} title="Reject payment request" destructive confirmLabel="Reject" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => rejectM.mutateAsync(v)} />
  </div>}</Modal>;
}
function SupplierPaymentsPageInner() {
  const { can } = useAuth(); const sp = useSearchParams(); const router = useRouter();
  const [open, setOpen] = useState<{ supplier_id?: string | null; invoice_id?: string | null } | null>(null); const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { if (sp.get('new')) setOpen({ supplier_id: sp.get('supplier_id'), invoice_id: sp.get('invoice_id') }); if (sp.get('id')) setSel(sp.get('id')); }, [sp]);
  return <div className="space-y-4">
    <PageHeader title="Supplier payments" subtitle="Payment requests against approved invoices. Approval limits route large payments to finance managers; posting reduces AP and the bank/cash account." actions={can('payments.pay_supplier') && <Button onClick={() => setOpen({})}><Plus />Pay supplier</Button>} />
    <DataTable path="/supplier-payments" defaultSort="created_at" onRowClick={(r) => setSel(r.id)} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED'] }, { key: 'supplier_id', label: 'Supplier', type: 'select', source: '/suppliers' }]}
      columns={[{ key: 'created_at', label: 'Date', type: 'datetime' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'method_name', label: 'Method' }, { key: 'reference', label: 'Reference' }, { key: 'payment_number', label: 'Payment' }, { key: 'requested_by_name', label: 'Requested by' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
    {open && <NewPayment open={!!open} preset={open} onOpenChange={(o) => { if (!o) { setOpen(null); router.replace('/procurement/supplier-payments'); } }} onCreated={(r) => setSel(r.id)} />}
    <PaymentDetail id={sel} onClose={() => { setSel(null); if (sp.get('id')) router.replace('/procurement/supplier-payments'); }} />
  </div>;
}
export default function SupplierPaymentsPage() { return <Suspense fallback={null}><SupplierPaymentsPageInner /></Suspense>; }
