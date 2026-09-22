'use client';
import React, { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Undo2, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, KV } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/shared/form';
import { AuditTrail } from '@/components/shared/audit-trail';
import { fmtDate, fmtDateTime, fmtMoney, titleCase, today } from '@/lib/utils';

const KINDS = ['GUEST_PAYMENT', 'DEPOSIT', 'POS_SALE', 'REFUND', 'SUPPLIER_PAYMENT', 'EXPENSE', 'PETTY_CASH', 'RECEIPT', 'TICKET', 'EVENT', 'SERVICE', 'OTHER'];
const sourceLink = (p: any) => { const t = p.source_type, id = p.source_id; if (!t || !id) return null; const map: Record<string, string> = { folio: `/front-office/folios?id=${id}`, order: `/pos/orders/${id}`, supplier_invoice: `/procurement/supplier-invoices?id=${id}`, supplier_payment_request: `/procurement/supplier-payments?id=${id}`, expense: `/finance/expenses?id=${id}`, event: `/events/${id}`, club_event: `/clubs/${id}`, invoice: `/finance/receivables?invoice=${id}` }; return map[String(t).toLowerCase()] ?? null; };
export function PaymentDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, currency } = useAuth(); const { data: p, refetch } = useApi<any>(id ? `/payments/${id}` : null); const [rev, setRev] = useState(false);
  const reverseM = useAction((v: any) => post(`/payments/${id}/reverse`, v), { success: 'Payment reversed', invalidate: ['/payments', '/journals'], onSuccess: () => { setRev(false); refetch(); } });
  if (!id) return null; const link = p ? sourceLink(p) : null;
  return <Modal open={!!id} onOpenChange={(o) => !o && onClose()} title={p ? <span className="flex items-center gap-2">{p.number} <StatusBadge status={p.status} /><Badge tone={p.direction === 'IN' ? 'success' : 'warning'}>{p.direction === 'IN' ? 'Money in' : 'Money out'}</Badge></span> : 'Payment'} size="lg">{p && <div className="space-y-4">
    <KV cols={3} items={[['Amount', <b key="a">{fmtMoney(p.amount, p.currency ?? currency)}</b>], ['Base amount', `${fmtMoney(p.base_amount, currency)}${Number(p.fx_rate) !== 1 ? ` @ ${p.fx_rate}` : ''}`], ['Method', `${p.method_name ?? p.method ?? ''}${p.method_type ? ` (${titleCase(p.method_type)})` : ''}`], ['Kind', titleCase(p.kind)], ['Business date', fmtDate(p.business_date)], ['Recorded', `${p.created_by_name ?? ''} · ${fmtDateTime(p.created_at)}`], ['Party', p.party_name ? `${p.party_name} (${titleCase(p.party_type)})` : p.party_type ? titleCase(p.party_type) : '—'], ['Reference', p.reference ?? '—'], ['Outlet / shift', [p.outlet_name, p.shift_number].filter(Boolean).join(' · ') || '—'], ['Source', p.source_type ? <span key="s" className="flex items-center gap-1">{titleCase(p.source_type)}{p.folio_number && ` · ${p.folio_number}`}{link && <Link href={link} className="text-primary"><ExternalLink className="h-3.5 w-3.5" /></Link>}</span> : '—'], ['Journal', p.journal_entry_id ? <Link key="j" href={`/finance/journals?id=${p.journal_entry_id}`} className="underline">View journal</Link> : '—'], ['Notes', p.notes ?? '—']]} />
    {p.folio_item && <div className="rounded border p-2 text-xs">Folio line: {p.folio_item.description} · {fmtMoney(p.folio_item.amount, currency)}{p.folio_item.is_reversed && ' (reversed)'}</div>}
    {p.status === 'COMPLETED' && !p.reversed_by_id && can('payments.refund', 'accounting.reverse') && <Button variant="outline" onClick={() => setRev(true)}><Undo2 />Reverse payment</Button>}
    {p.reversed_by_id && <div className="text-sm text-muted-foreground">Reversed by payment {String(p.reversed_by_id).slice(0, 8)}.</div>}
    <AuditTrail entity="payment" entityId={id} />
    <ConfirmDialog open={rev} onOpenChange={setRev} title="Reverse payment" description="Posts an opposite payment and a reversing journal; the folio/ledger balance is restored. The original record stays untouched." destructive confirmLabel="Reverse" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => reverseM.mutateAsync(v)} />
  </div>}</Modal>;
}
function PaymentsInner() {
  const { currency } = useAuth(); const sp = useSearchParams(); const router = useRouter(); const [sel, setSel] = useState<string | null>(null); const [from, setFrom] = useState(today().slice(0, 8) + '01'); const [to, setTo] = useState(today());
  useEffect(() => { if (sp.get('id')) setSel(sp.get('id')); }, [sp]);
  const { data: sum } = useApi<any>('/payments/summary', { from, to });
  return <div className="space-y-4">
    <PageHeader title="Payments" subtitle="Every receipt and disbursement across front office, POS, AR, AP and expenses — one register, one audit trail." actions={<div className="flex items-end gap-2"><div className="flex flex-col gap-1"><Label>From</Label><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></div><div className="flex flex-col gap-1"><Label>To</Label><Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} /></div></div>} />
    <div className="grid gap-3 grid-cols-2 md:grid-cols-4"><div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">Money in</div><div className="text-lg font-semibold tabular text-emerald-600">{fmtMoney(sum?.totals?.in, currency)}</div></div><div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">Money out</div><div className="text-lg font-semibold tabular text-destructive">{fmtMoney(sum?.totals?.out, currency)}</div></div><div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">Net</div><div className="text-lg font-semibold tabular">{fmtMoney(sum?.totals?.net, currency)}</div></div><div className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">By method</div><ul className="text-xs">{(sum?.by_method ?? []).slice(0, 4).map((m: any, i: number) => <li key={i} className="flex justify-between"><span>{m.method ?? m.method_name}</span><span className="tabular">{fmtMoney(m.amount, currency)}</span></li>)}</ul></div></div>
    <DataTable path="/payments" defaultSort="created_at" onRowClick={(r) => setSel(r.id)} exportName="payments" filters={[{ key: 'direction', label: 'Direction', type: 'select', options: ['IN', 'OUT'] }, { key: 'kind', label: 'Kind', type: 'select', options: KINDS }, { key: 'status', label: 'Status', type: 'select', options: ['COMPLETED', 'REVERSED', 'PENDING', 'FAILED'] }, { key: 'payment_method_id', label: 'Method', type: 'select', source: '/payment-methods', sourceLabel: 'name' }, { key: 'outlet_id', label: 'Outlet', type: 'select', source: '/outlets', sourceLabel: 'name' }, { key: 'date', label: 'Business date', type: 'daterange' }]}
      columns={[{ key: 'number', label: 'No.' }, { key: 'business_date', label: 'Date', type: 'date' }, { key: 'direction', label: 'Dir', render: (r) => <Badge tone={r.direction === 'IN' ? 'success' : 'warning'}>{r.direction}</Badge> }, { key: 'kind', label: 'Kind', render: (r) => titleCase(r.kind) }, { key: 'method_name', label: 'Method' }, { key: 'party_name', label: 'Party', render: (r) => r.party_name ?? (r.folio_number ? `Folio ${r.folio_number}` : '—') }, { key: 'reference', label: 'Reference', hideOnMobile: true }, { key: 'outlet_name', label: 'Outlet', hideOnMobile: true }, { key: 'amount', label: 'Amount', type: 'money', render: (r) => <span className={r.direction === 'OUT' ? 'text-destructive' : ''}>{r.direction === 'OUT' ? '-' : ''}{fmtMoney(r.amount, r.currency ?? currency)}</span> }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
    <PaymentDetail id={sel} onClose={() => { setSel(null); if (sp.get('id')) router.replace('/finance/payments'); }} />
  </div>;
}
export function PaymentsPage() { return <Suspense fallback={null}><PaymentsInner /></Suspense>; }
