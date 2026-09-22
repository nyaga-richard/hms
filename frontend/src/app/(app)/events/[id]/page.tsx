'use client';
import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { FileText, Wallet, Plus, Receipt, ClipboardList } from 'lucide-react';
import { post, get } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { FormDialog, ConfirmDialog } from '@/components/shared/form';
import { Modal } from '@/components/ui/dialog';
import { NativeSelect } from '@/components/ui/input';
import { fmtDateTime, fmtMoney, titleCase, fmtDate } from '@/lib/utils';
import { PaymentLineFields, PaymentsEditor, type PaymentLine } from '@/components/pms/payment-fields';
import { Attachments } from '@/components/shared/attachments';
import { Switch } from '@/components/ui/misc';

const FLOW: Record<string, string[]> = { TENTATIVE: ['QUOTED', 'CONFIRMED', 'CANCELLED'], QUOTED: ['CONFIRMED', 'CANCELLED'], CONFIRMED: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['COMPLETED'], COMPLETED: [], CANCELLED: [] };
export default function EventDetail() {
  const { id } = useParams<{ id: string }>(); const router = useRouter(); const { can, currency } = useAuth();
  const { data: e, isLoading, refetch } = useApi<any>(`/events/${id}`);
  const [status, setStatus] = useState<string | null>(null); const [charge, setCharge] = useState(false); const [pay, setPay] = useState(false); const [invoice, setInvoice] = useState(false); const [beo, setBeo] = useState<any>(null);
  const [payment, setPayment] = useState<PaymentLine>({ amount: '' }); const [payKind, setPayKind] = useState<'DEPOSIT' | 'PAYMENT' | 'REFUND'>('DEPOSIT'); const [invPays, setInvPays] = useState<PaymentLine[]>([{ amount: '' }]); const [allowBal, setAllowBal] = useState(false);
  const inv = ['/events', '/folios', '/payments', '/dashboard'];
  const statusM = useAction((v: any) => post(`/events/${id}/status`, { status, notes: v?.notes }), { success: 'Status updated', invalidate: inv, onSuccess: () => { setStatus(null); refetch(); } });
  const chargeM = useAction((v: any) => post(`/events/${id}/charges`, v), { success: 'Charge added', invalidate: inv, onSuccess: () => refetch() });
  const payM = useAction(() => post(`/events/${id}/payments`, { ...payment, kind: payKind }), { success: 'Payment recorded', invalidate: inv, onSuccess: () => { setPay(false); refetch(); } });
  const invM = useAction(() => post(`/events/${id}/invoice`, { payments: invPays.filter((p) => Number(p.amount) > 0 && p.payment_method_id), allow_balance: allowBal }), { success: 'Invoice generated', invalidate: inv, onSuccess: () => { setInvoice(false); refetch(); } });
  const revM = useAction((itemId: string) => post(`/events/${id}/charges/${itemId}/reverse`, { reason: 'Reversed from event screen' }), { success: 'Charge reversed', invalidate: inv, onSuccess: () => refetch() });
  if (isLoading || !e) return <Spinner />;
  const balance = Number(e.quotation_total ?? 0) - Number(e.deposit_paid ?? 0); const folioBal = (e.folio_items ?? []).filter((i: any) => !i.is_reversed).reduce((s: number, i: any) => s + Number(i.amount), 0);
  return <div className="space-y-4">
    <PageHeader crumbs={[{ label: 'Events', href: '/events' }, { label: e.number }]} title={<span className="flex items-center gap-2">{e.name} <StatusBadge status={e.status} /><Badge tone="muted">{titleCase(e.type)}</Badge></span>} subtitle={`${e.number} · ${fmtDateTime(e.start_at)} → ${fmtDateTime(e.end_at)} · ${e.venue_name ?? 'no venue'} · ${e.expected_guests} pax`}
      actions={<>
        <Button variant="outline" onClick={async () => setBeo(await get(`/events/${id}/beo`))}><ClipboardList />BEO</Button>
        {can('events.manage') && FLOW[e.status]?.length > 0 && <NativeSelect className="h-9 w-44" value="" onChange={(ev) => ev.target.value && setStatus(ev.target.value)}><option value="">Change status…</option>{FLOW[e.status].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</NativeSelect>}
        {can('events.manage') && !['COMPLETED', 'CANCELLED'].includes(e.status) && <Button variant="outline" onClick={() => setCharge(true)}><Plus />Charge</Button>}
        {can('payments.create') && !['CANCELLED'].includes(e.status) && <Button variant="outline" onClick={() => setPay(true)}><Wallet />Payment</Button>}
        {can('events.manage') && ['IN_PROGRESS', 'COMPLETED', 'CONFIRMED'].includes(e.status) && !e.invoice_id && <Button onClick={() => setInvoice(true)}><Receipt />Generate invoice</Button>}
        {e.folio_id && <Button variant="outline" onClick={() => router.push(`/front-office/folios/${e.folio_id}`)}><FileText />Folio {e.folio_number}</Button>}
      </>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        <Section title="Quotation / charges"><table className="w-full text-sm"><thead className="text-xs uppercase text-muted-foreground"><tr><th className="text-left py-1">Type</th><th className="text-left">Description</th><th className="text-right">Qty</th><th className="text-right">Unit</th><th className="text-right">Total</th><th /></tr></thead><tbody className="divide-y">{(e.items ?? []).map((i: any) => <tr key={i.id}><td className="py-1"><Badge tone="muted">{titleCase(i.item_type)}</Badge></td><td>{i.description}{i.tax_name && <span className="text-xs text-muted-foreground"> · {i.tax_name}</span>}</td><td className="text-right tabular">{i.quantity}</td><td className="text-right tabular">{fmtMoney(i.unit_price, currency)}</td><td className="text-right tabular">{fmtMoney(i.total ?? i.quantity * i.unit_price, currency)}</td><td className="text-right">{can('events.manage') && i.folio_item_id && !i.reversed && <Button size="sm" variant="ghost" onClick={() => revM.mutate(i.id)}>Reverse</Button>}</td></tr>)}</tbody><tfoot><tr className="font-semibold"><td colSpan={4} className="py-2 text-right">Quotation total</td><td className="text-right tabular">{fmtMoney(e.quotation_total, currency)}</td><td /></tr></tfoot></table></Section>
        {e.folio_items && <Section title={`Event folio ${e.folio_number ?? ''}`} actions={<span className={`text-sm font-semibold tabular ${folioBal > 0 ? 'text-destructive' : 'text-emerald-600'}`}>Balance {fmtMoney(folioBal, currency)}</span>}><ul className="divide-y text-sm">{e.folio_items.map((i: any) => <li key={i.id} className={`flex justify-between py-1 ${i.is_reversed ? 'line-through text-muted-foreground' : ''}`}><span>{fmtDate(i.business_date)} · {i.description}</span><span className="tabular">{fmtMoney(i.amount, currency)}</span></li>)}</ul></Section>}
      </div>
      <div className="space-y-4">
        <Section title="Client"><KV cols={1} items={[['Company', e.customer_name ?? '—'], ['Guest', e.guest_name ?? '—'], ['Contact', [e.contact_name, e.contact_phone, e.contact_email].filter(Boolean).join(' · ') || '—'], ['Setup', e.setup_style ?? '—'], ['Deposit required', fmtMoney(e.deposit_required, currency)], ['Deposit / payments', fmtMoney(e.deposit_paid, currency)], ['Outstanding (quote)', <span key="b" className={balance > 0 ? 'text-destructive' : ''}>{fmtMoney(balance, currency)}</span>], ['Invoice', e.invoice_number ?? '—'], ['Created by', e.created_by_name]]} /></Section>
        <Section title="Notes"><KV cols={1} items={[['Menu', e.menu_notes ?? '—'], ['Equipment', e.equipment_notes ?? '—'], ['Staffing', e.staff_notes ?? '—'], ['Other', e.notes ?? '—']]} /></Section>
        <Section title="History"><ul className="text-sm space-y-1">{(e.history ?? []).map((h: any) => <li key={h.id}><span className="text-xs text-muted-foreground">{fmtDateTime(h.created_at)}</span> {titleCase(h.from_status ?? '')} → <b>{titleCase(h.to_status ?? h.status)}</b> {h.user_name && `· ${h.user_name}`}{h.notes && <div className="text-muted-foreground">{h.notes}</div>}</li>)}</ul></Section>
      </div>
    </div>
    <Attachments entity="event" entityId={id} title="Contract, BEO & attachments" />
    <ConfirmDialog open={!!status} onOpenChange={(o) => !o && setStatus(null)} title={`Set status to ${titleCase(status ?? '')}?`} description={status === 'CONFIRMED' ? 'Confirming blocks the venue and opens the event folio; quotation lines post as charges.' : status === 'CANCELLED' ? 'Cancellation releases the venue.' : undefined} destructive={status === 'CANCELLED'} confirmLabel="Update" fields={[{ name: 'notes', label: 'Notes' }]} onConfirm={(v) => statusM.mutateAsync(v)} />
    <FormDialog open={charge} onOpenChange={setCharge} title="Add charge" size="sm" initial={{ item_type: 'OTHER', quantity: 1 }} fields={[{ name: 'item_type', label: 'Type', type: 'select', options: ['VENUE', 'MENU', 'BEVERAGE', 'EQUIPMENT', 'STAFF', 'ACCOMMODATION', 'SERVICE', 'OTHER'] }, { name: 'description', label: 'Description', required: true, col: 2 }, { name: 'quantity', label: 'Quantity', type: 'number' }, { name: 'unit_price', label: 'Unit price', type: 'money', required: true }, { name: 'tax_id', label: 'Tax', type: 'lookup', source: '/taxes' }]} onSubmit={(v) => chargeM.mutateAsync(v)} />
    <Modal open={pay} onOpenChange={setPay} title="Record event payment" size="sm"><div className="space-y-3"><div className="flex gap-1">{(['DEPOSIT', 'PAYMENT', 'REFUND'] as const).map((k) => <Button key={k} size="sm" variant={payKind === k ? 'default' : 'outline'} onClick={() => setPayKind(k)}>{titleCase(k)}</Button>)}</div><PaymentLineFields value={payment} onChange={setPayment} /><div className="flex justify-end"><Button loading={payM.isPending} disabled={!payment.payment_method_id || !(Number(payment.amount) > 0)} onClick={() => payM.mutate(undefined as any)}>Record</Button></div></div></Modal>
    <Modal open={invoice} onOpenChange={setInvoice} title="Generate event invoice" size="md"><div className="space-y-3"><p className="text-sm text-muted-foreground">Closes the event folio into an invoice. Folio balance {fmtMoney(folioBal, currency)}. Collect the remaining amount now or bill the corporate account.</p>{folioBal > 0 && <PaymentsEditor lines={invPays} onChange={setInvPays} due={folioBal} />}{can('receivables.manage') && <label className="flex items-center gap-2 text-sm"><Switch checked={allowBal} onCheckedChange={setAllowBal} /> Invoice on credit (balance to receivables{e.customer_name ? ` · ${e.customer_name}` : ''})</label>}<div className="flex justify-end"><Button loading={invM.isPending} onClick={() => invM.mutate(undefined as any)}><Receipt />Generate invoice</Button></div></div></Modal>
    <Modal open={!!beo} onOpenChange={(o) => !o && setBeo(null)} title="Banquet Event Order" size="lg">{beo && <div className="space-y-3 text-sm print:text-black" id="beo-print">
      <KV cols={2} items={[['Event', `${beo.event?.name} (${beo.event?.number})`], ['Client', beo.event?.customer_name ?? beo.event?.guest_name ?? beo.event?.contact_name ?? '—'], ['Venue', beo.event?.venue_name ?? 'TBD'], ['Guests / setup', `${beo.event?.expected_guests} · ${beo.event?.setup_style ?? ''}`], ['Setup from', fmtDateTime(beo.timeline?.setup_from)], ['Event', `${fmtDateTime(beo.timeline?.start_at)} → ${fmtDateTime(beo.timeline?.end_at)}`], ['Contact', [beo.event?.contact_name, beo.event?.contact_phone].filter(Boolean).join(' · ') || '—'], ['Status', titleCase(beo.event?.status ?? '')]]} />
      {Object.entries(beo.sections ?? {}).map(([sec, rows]: any) => <div key={sec}><div className="font-semibold uppercase text-xs text-muted-foreground mb-1">{titleCase(sec)}</div><ul className="divide-y rounded border">{(Array.isArray(rows) ? rows : []).map((r: any, i: number) => <li key={i} className="flex justify-between px-2 py-1"><span>{r.description}</span><span className="tabular text-muted-foreground">× {r.quantity}</span></li>)}</ul></div>)}
      <div className="grid grid-cols-3 gap-3">{[['Menu', beo.event?.menu_notes], ['Equipment', beo.event?.equipment_notes], ['Staffing', beo.event?.staff_notes]].map(([k, v]: any) => <div key={k} className="rounded border p-2"><div className="text-xs uppercase text-muted-foreground">{k}</div><div className="whitespace-pre-wrap">{v || '—'}</div></div>)}</div>
      <div className="flex justify-end print:hidden"><Button onClick={() => window.print()}>Print</Button></div></div>}</Modal>
  </div>;
}
