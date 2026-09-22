'use client';
import React, { useState } from 'react';
import { LockOpen, Lock, ShieldCheck } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/badge';
import { FormDialog, ConfirmDialog } from '@/components/shared/form';
import { fmtMoney, fmtDateTime } from '@/lib/utils';
/** Cashier shifts: open with float, close with declared cash → variance computed server-side; large variances route to approval. */
export default function ShiftsPage() {
  const { can, currency } = useAuth(); const { data: cur, refetch } = useApi<any>('/shifts/current');
  const [open, setOpen] = useState(false); const [close, setClose] = useState(false); const [approve, setApprove] = useState<any>(null); const [tick, setTick] = useState(0);
  const openM = useAction((v: any) => post('/shifts/open', { ...v, outlet_id: v.outlet_id || null }), { success: 'Shift opened', invalidate: ['/shifts'], onSuccess: () => refetch() });
  const closeM = useAction((v: any) => post(`/shifts/${cur.shift.id}/close`, { ...v, actual_cash: Number(v.actual_cash) }), { success: 'Shift closed', invalidate: ['/shifts'], onSuccess: () => { refetch(); setTick((t) => t + 1); } });
  const approveM = useAction((v: any) => post(`/shifts/${approve.id}/approve-variance`, v), { success: 'Variance approved', invalidate: ['/shifts'], onSuccess: () => setTick((t) => t + 1) });
  const s = cur?.shift;
  return <div className="space-y-4">
    <PageHeader title="Cashier shifts" subtitle="Every payment is tied to an open shift; closing reconciles expected vs counted cash." actions={s ? can('pos.close_shift') && <Button onClick={() => setClose(true)}><Lock />Close my shift</Button> : can('pos.open_shift') && <Button onClick={() => setOpen(true)}><LockOpen />Open shift</Button>} />
    {s && <Section title={`My open shift · ${s.number ?? ''} · ${s.outlet_name ?? 'Front desk'}`}><KV cols={4} items={[['Opened', fmtDateTime(s.opened_at)], ['Opening float', fmtMoney(s.opening_float, currency)], ['Cash in', fmtMoney(cur.cash_in, currency)], ['Cash out (refunds)', fmtMoney(cur.cash_out, currency)], ['Expected cash', <b key="e">{fmtMoney(cur.expected_cash, currency)}</b>], ['Orders closed', `${cur.orders?.count ?? 0} · ${fmtMoney(cur.orders?.total, currency)}`], ['Voids', cur.voids], ['Refunds', `${cur.refunds?.count ?? 0} · ${fmtMoney(cur.refunds?.total, currency)}`]]} />
      {cur.by_method?.length > 0 && <table className="mt-3 w-full text-sm"><thead className="text-xs uppercase text-muted-foreground"><tr><th className="text-left py-1">Method</th><th className="text-right">Count</th><th className="text-right">Amount</th></tr></thead><tbody className="divide-y">{cur.by_method.map((m: any, i: number) => <tr key={i}><td className="py-1">{m.method_name ?? m.name} {m.direction === 'OUT' && '(out)'}</td><td className="text-right tabular">{m.count}</td><td className="text-right tabular">{fmtMoney(m.amount, currency)}</td></tr>)}</tbody></table>}</Section>}
    <DataTable path="/shifts" defaultSort="opened_at" refreshKey={tick} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['OPEN', 'CLOSED', 'PENDING_APPROVAL'] }, { key: 'outlet_id', label: 'Outlet', type: 'select', source: '/outlets' }, { key: 'date', label: 'Business date', type: 'date' }]}
      columns={[{ key: 'number', label: 'Shift' }, { key: 'business_date', label: 'Date', type: 'date' }, { key: 'cashier_name', label: 'Cashier' }, { key: 'outlet_name', label: 'Outlet' }, { key: 'opened_at', label: 'Opened', type: 'datetime' }, { key: 'closed_at', label: 'Closed', type: 'datetime' }, { key: 'opening_float', label: 'Float', type: 'money' }, { key: 'expected_cash', label: 'Expected', type: 'money' }, { key: 'actual_cash', label: 'Counted', type: 'money' }, { key: 'variance', label: 'Variance', render: (r) => r.variance === null || r.variance === undefined ? '' : <span className={Number(r.variance) !== 0 ? 'text-destructive tabular font-medium' : 'tabular'}>{fmtMoney(r.variance, currency)}</span> }, { key: 'order_count', label: 'Orders', type: 'number', decimals: 0 }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]}
      rowActions={(r) => r.status === 'PENDING_APPROVAL' && can('pos.approve_variance') ? <Button size="sm" variant="outline" onClick={() => setApprove(r)}><ShieldCheck />Approve variance</Button> : null} />
    <FormDialog open={open} onOpenChange={setOpen} title="Open cashier shift" size="sm" cols={1} initial={{ opening_float: 0 }} fields={[{ name: 'outlet_id', label: 'Outlet (blank = front desk)', type: 'lookup', source: '/outlets' }, { name: 'opening_float', label: 'Opening cash float', type: 'money', required: true }, { name: 'notes', label: 'Notes' }]} submitLabel="Open shift" onSubmit={(v) => openM.mutateAsync(v)} />
    <FormDialog open={close} onOpenChange={setClose} title={`Close shift · expected cash ${fmtMoney(cur?.expected_cash, currency)}`} size="sm" cols={1} fields={[{ name: 'actual_cash', label: 'Counted cash in drawer', type: 'money', required: true }, { name: 'variance_reason', label: 'Variance reason (if any)' }, { name: 'notes', label: 'Notes', type: 'textarea' }]} submitLabel="Close shift" onSubmit={(v) => closeM.mutateAsync(v)} />
    <ConfirmDialog open={!!approve} onOpenChange={(o) => !o && setApprove(null)} title={`Approve variance of ${fmtMoney(approve?.variance, currency)}?`} description={approve?.variance_reason} confirmLabel="Approve" fields={[{ name: 'notes', label: 'Comment' }]} onConfirm={(v) => approveM.mutateAsync(v)} />
  </div>;
}
