'use client';
import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { LogIn, Ban, UserX, Wallet, Pencil, Split } from 'lucide-react';
import { post, put } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { ConfirmDialog, FormDialog } from '@/components/shared/form';
import { Modal } from '@/components/ui/dialog';
import { fmtDate, fmtDateTime, fmtMoney, titleCase } from '@/lib/utils';
import { CheckInDialog } from '@/components/pms/checkin-dialog';
import { PaymentLineFields, type PaymentLine } from '@/components/pms/payment-fields';
import { Attachments } from '@/components/shared/attachments';
import { AuditTrail } from '@/components/shared/audit-trail';
import { PrintButton, ReservationDoc } from '@/lib/print';

export default function ReservationDetail() {
  const { id } = useParams<{ id: string }>(); const router = useRouter(); const { can, currency } = useAuth();
  const { data: r, isLoading, refetch } = useApi<any>(`/reservations/${id}`);
  const [checkin, setCheckin] = useState(false); const [cancel, setCancel] = useState(false); const [noShow, setNoShow] = useState(false); const [edit, setEdit] = useState(false); const [dep, setDep] = useState(false);
  const [deposit, setDeposit] = useState<PaymentLine>({ amount: '' });
  const cancelM = useAction((v: any) => post(`/reservations/${id}/cancel`, { reason: v.reason }), { success: 'Reservation cancelled', invalidate: ['/reservations'], onSuccess: () => refetch() });
  const noShowM = useAction(() => post(`/reservations/${id}/no-show`, {}), { success: 'Marked no-show', invalidate: ['/reservations'], onSuccess: () => refetch() });
  const depositM = useAction(() => post(`/reservations/${id}/deposit`, deposit), { success: 'Deposit recorded', invalidate: ['/reservations'], onSuccess: () => { setDep(false); refetch(); } });
  const editM = useAction((v: any) => put(`/reservations/${id}`, v), { success: 'Reservation updated', invalidate: ['/reservations'], onSuccess: () => refetch() });
  if (isLoading || !r) return <Spinner />;
  const active = ['INQUIRY', 'TENTATIVE', 'CONFIRMED', 'DEPOSIT_PAID'].includes(r.status);
  return <div className="space-y-4">
    <PageHeader crumbs={[{ label: 'Front office', href: '/front-office' }, { label: 'Reservations', href: '/front-office/reservations' }, { label: r.number }]} title={<span className="flex items-center gap-2">{r.number} <StatusBadge status={r.status} />{r.is_overbooking && <Badge tone="destructive">Overbooked</Badge>}</span>} subtitle={`${r.guest_name} · ${fmtDate(r.arrival_date)} → ${fmtDate(r.departure_date)} · ${r.nights} night(s)`}
      actions={<>
        <PrintButton doc="confirmation" label="Confirmation" title={`Reservation ${r.number}`} render={(ctx) => <ReservationDoc r={r} ctx={ctx} />} />
        {active && can('reservations.modify') && <Button variant="outline" onClick={() => setEdit(true)}><Pencil />Modify</Button>}
        {active && can('payments.create') && <Button variant="outline" onClick={() => setDep(true)}><Wallet />Deposit</Button>}
        {active && can('reservations.no_show') && <Button variant="outline" onClick={() => setNoShow(true)}><UserX />No-show</Button>}
        {active && can('reservations.cancel') && <Button variant="destructive" onClick={() => setCancel(true)}><Ban />Cancel</Button>}
        {active && can('checkin.create') && <Button onClick={() => setCheckin(true)}><LogIn />Check in</Button>}
        {r.status === 'CHECKED_IN' && r.stay_id && <Button onClick={() => router.push(`/front-office/stays/${r.stay_id}`)}>Open stay</Button>}
      </>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <Section title="Booking" className="lg:col-span-2"><KV cols={3} items={[['Guest', <a key="g" href={`/front-office/guests/${r.guest_id}`} className="text-primary hover:underline">{r.guest_name}</a>], ['Phone', r.guest_phone ?? '—'], ['Email', r.guest_email ?? '—'], ['Company', r.customer_name ?? '—'], ['Room type', r.room_type_name], ['Room', r.room_number ?? 'Unassigned'], ['Rate plan', r.rate_plan_name ?? 'Standard'], ['Rate / night', fmtMoney(r.rate, currency)], ['Meal plan', r.meal_plan ?? '—'], ['Occupancy', `${r.adults} adults · ${r.children} children`], ['Source', titleCase(r.source)], ['ETA', r.eta ?? '—'], ['Deposit required', fmtMoney(r.deposit_required, currency)], ['Deposit paid', fmtMoney(r.deposit_paid, currency)], ['External ref', r.external_ref ?? '—'], ['Special requests', r.special_requests ?? '—'], ['Notes', r.notes ?? '—'], ['Created', `${fmtDateTime(r.created_at)} by ${r.created_by_name ?? '—'}`], ...(r.cancelled_at ? [['Cancelled', `${fmtDateTime(r.cancelled_at)} — ${r.cancellation_reason}`] as [string, React.ReactNode]] : [])]} />
        {r.guests?.length > 1 && <div className="mt-3 text-sm"><div className="font-medium mb-1">Accompanying guests</div><ul className="list-disc pl-5">{r.guests.filter((g: any) => g.id !== r.guest_id).map((g: any) => <li key={g.id}>{g.full_name ?? `${g.first_name} ${g.last_name}`}</li>)}</ul></div>}
      </Section>
      <div className="space-y-4">
        <Section title="Folios & payments">{r.folios?.length ? r.folios.map((f: any) => <a key={f.id} href={`/front-office/folios/${f.id}`} className="flex items-center justify-between rounded-md border p-2 text-sm hover:bg-accent mb-1"><span>{f.number} <Badge tone="muted">{f.type}</Badge></span><span className="tabular">{fmtMoney(f.balance, currency)}</span></a>) : <p className="text-sm text-muted-foreground">No folio yet — created at check-in.</p>}
          {r.payments?.length > 0 && <ul className="mt-2 text-sm divide-y">{r.payments.map((p: any) => <li key={p.id} className="flex justify-between py-1"><span>{fmtDate(p.created_at)} · {p.method_name ?? p.payment_method_name ?? p.kind}</span><span className="tabular">{fmtMoney(p.amount, currency)}</span></li>)}</ul>}
        </Section>
        <Section title="History"><ul className="text-sm space-y-1 max-h-72 overflow-y-auto">{(r.history ?? []).map((h: any) => <li key={h.id} className="flex gap-2"><span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(h.created_at)}</span><span><b>{titleCase(h.action)}</b> {h.user_name ? `by ${h.user_name}` : ''}{h.details && typeof h.details === 'object' && Object.keys(h.details).length > 0 && <span className="text-muted-foreground"> — {Object.entries(h.details).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}</span>}</span></li>)}</ul></Section>
      </div>
    </div>
    <div className="grid gap-4 lg:grid-cols-2"><Attachments entity="reservation" entityId={id} /><AuditTrail entity="reservations" entityId={id} /></div>
    <CheckInDialog open={checkin} onOpenChange={setCheckin} reservation={r} onDone={() => refetch()} />
    <ConfirmDialog open={cancel} onOpenChange={setCancel} title="Cancel reservation" description="Applies the cancellation policy; deposits are handled per policy." destructive confirmLabel="Cancel reservation" fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]} onConfirm={(v) => cancelM.mutateAsync(v)} />
    <ConfirmDialog open={noShow} onOpenChange={setNoShow} title="Mark as no-show" description="The guest did not arrive. Deposit forfeiture is posted automatically when configured." destructive confirmLabel="Mark no-show" onConfirm={() => noShowM.mutateAsync(undefined as any)} />
    <Modal open={dep} onOpenChange={setDep} title="Record deposit" size="sm"><PaymentLineFields value={deposit} onChange={setDeposit} /><div className="mt-4 flex justify-end"><Button loading={depositM.isPending} disabled={!deposit.payment_method_id || !(Number(deposit.amount) > 0)} onClick={() => depositM.mutate(undefined as any)}>Record deposit</Button></div></Modal>
    <FormDialog open={edit} onOpenChange={setEdit} title="Modify reservation" size="lg" initial={{ arrival_date: r.arrival_date?.slice(0, 10), departure_date: r.departure_date?.slice(0, 10), room_type_id: r.room_type_id, room_id: r.room_id, adults: r.adults, children: r.children, rate: r.rate, meal_plan: r.meal_plan, status: r.status, eta: r.eta, special_requests: r.special_requests, notes: r.notes, deposit_required: r.deposit_required }}
      fields={[{ name: 'arrival_date', label: 'Arrival', type: 'date', required: true }, { name: 'departure_date', label: 'Departure', type: 'date', required: true }, { name: 'room_type_id', label: 'Room type', type: 'lookup', source: '/room-types', required: true }, { name: 'room_id', label: 'Room', type: 'lookup', source: '/rooms', sourceLabel: 'number', sourceQuery: { pageSize: 500 } }, { name: 'adults', label: 'Adults', type: 'number', min: 1 }, { name: 'children', label: 'Children', type: 'number', min: 0 }, { name: 'rate', label: 'Rate / night', type: 'money' }, { name: 'meal_plan', label: 'Meal plan', type: 'select', options: ['RO', 'BB', 'HB', 'FB', 'AI'] }, { name: 'status', label: 'Status', type: 'select', options: ['INQUIRY', 'TENTATIVE', 'CONFIRMED', 'DEPOSIT_PAID'] }, { name: 'eta', label: 'ETA', type: 'time' }, { name: 'deposit_required', label: 'Deposit required', type: 'money' }, { name: 'special_requests', label: 'Special requests', type: 'textarea', col: 2 }, { name: 'notes', label: 'Notes', type: 'textarea', col: 2 }, { name: 'reason', label: 'Reason for change', type: 'text', col: 2, required: true }]}
      onSubmit={(v) => editM.mutateAsync(v)} />
  </div>;
}
