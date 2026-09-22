'use client';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus, PartyPopper } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { LookupSelect } from '@/components/shared/form';
import { Steps } from '@/components/pms/checkin-dialog';
import { KV } from '@/components/shared/page';
import { fmtDateTime, fmtMoney, titleCase, today, addDays, fmtDate } from '@/lib/utils';

export const EVENT_TYPES = ['BANQUET', 'CONFERENCE', 'WEDDING', 'MEETING', 'PARTY', 'EXHIBITION', 'OTHER'];
const ITEM_TYPES = ['VENUE', 'MENU', 'BEVERAGE', 'EQUIPMENT', 'STAFF', 'ACCOMMODATION', 'SERVICE', 'OTHER'];
/** Event/banquet wizard: details → venue & schedule (availability checked server-side) → quotation lines → confirm. */
export function EventWizard({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (e: any) => void }) {
  const { currency } = useAuth(); const [step, setStep] = useState(0);
  const [f, setF] = useState<any>({ name: '', type: 'BANQUET', customer_id: '', guest_id: '', contact_name: '', contact_phone: '', contact_email: '', venue_id: '', start_at: `${addDays(today(), 7)}T09:00`, end_at: `${addDays(today(), 7)}T17:00`, expected_guests: 50, setup_style: 'BANQUET', deposit_required: '', menu_notes: '', equipment_notes: '', staff_notes: '', notes: '' });
  const [items, setItems] = useState<any[]>([{ item_type: 'VENUE', description: 'Venue hire', quantity: 1, unit_price: '' }]);
  const { data: venues } = useApi<any>('/venues', { pageSize: 100 }, { enabled: open });
  const { data: avail } = useApi<any>('/venues/availability', { from: f.start_at, to: f.end_at }, { enabled: open && step === 1 });
  const venue = (venues?.data ?? []).find((v: any) => v.id === f.venue_id);
  const total = items.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unit_price || 0), 0);
  const create = useAction(() => post('/events', { ...f, customer_id: f.customer_id || null, guest_id: f.guest_id || null, venue_id: f.venue_id || null, deposit_required: f.deposit_required ? Number(f.deposit_required) : 0, expected_guests: Number(f.expected_guests), items: items.filter((i) => i.description && i.unit_price !== '').map((i) => ({ ...i, quantity: Number(i.quantity), unit_price: Number(i.unit_price) })) }), { success: 'Event created', invalidate: ['/events', '/venues'], onSuccess: (e: any) => { onOpenChange(false); onCreated?.(e); } });
  const steps = ['Client & event', 'Venue & schedule', 'Quotation', 'Confirm']; const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const availRows: any[] = Array.isArray(avail) ? avail : avail?.data ?? [];
  return <Modal open={open} onOpenChange={onOpenChange} title="New event / banquet" size="xl"><Steps steps={steps} current={step} />
    {step === 0 && <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="flex flex-col gap-1 col-span-2"><Label>Event name</Label><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Acme Annual Gala" /></div>
      <div className="flex flex-col gap-1"><Label>Type</Label><NativeSelect value={f.type} onChange={(e) => set('type', e.target.value)}>{EVENT_TYPES.map((t) => <option key={t}>{t}</option>)}</NativeSelect></div>
      <div className="flex flex-col gap-1"><Label>Expected guests</Label><Input type="number" min={0} value={f.expected_guests} onChange={(e) => set('expected_guests', e.target.value)} /></div>
      <div className="flex flex-col gap-1 col-span-2"><Label>Corporate client</Label><LookupSelect source="/customers" value={f.customer_id} onChange={(v) => set('customer_id', v)} placeholder="None" /></div>
      <div className="flex flex-col gap-1 col-span-2"><Label>Or individual guest</Label><LookupSelect source="/guests" sourceLabel="full_name" value={f.guest_id} onChange={(v) => set('guest_id', v)} placeholder="None" /></div>
      <div className="flex flex-col gap-1"><Label>Contact name</Label><Input value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></div><div className="flex flex-col gap-1"><Label>Contact phone</Label><Input value={f.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} /></div><div className="flex flex-col gap-1 col-span-2"><Label>Contact email</Label><Input type="email" value={f.contact_email} onChange={(e) => set('contact_email', e.target.value)} /></div>
    </div>}
    {step === 1 && <div className="space-y-3"><div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="flex flex-col gap-1"><Label>Start</Label><Input type="datetime-local" value={f.start_at} onChange={(e) => set('start_at', e.target.value)} /></div><div className="flex flex-col gap-1"><Label>End</Label><Input type="datetime-local" value={f.end_at} onChange={(e) => set('end_at', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Setup style</Label><NativeSelect value={f.setup_style} onChange={(e) => set('setup_style', e.target.value)}>{['BANQUET', 'THEATRE', 'CLASSROOM', 'COCKTAIL', 'BOARDROOM', 'U_SHAPE'].map((s) => <option key={s}>{s}</option>)}</NativeSelect></div>
      <div className="flex flex-col gap-1"><Label>Deposit required</Label><Input type="number" step="0.01" value={f.deposit_required} onChange={(e) => set('deposit_required', e.target.value)} /></div></div>
      <div className="grid gap-2 md:grid-cols-2">{(venues?.data ?? []).map((v: any) => { const clash = (availRows.find((b: any) => b.id === v.id)?.bookings ?? []).length > 0; const cap = { BANQUET: v.capacity_banquet, THEATRE: v.capacity_theatre, CLASSROOM: v.capacity_classroom, COCKTAIL: v.capacity_cocktail }[f.setup_style as string] ?? v.capacity_banquet; return <button type="button" key={v.id} onClick={() => set('venue_id', v.id)} className={`rounded-lg border p-3 text-left ${f.venue_id === v.id ? 'border-primary ring-1 ring-primary bg-primary/5' : ''}`}><div className="flex justify-between"><span className="font-medium">{v.name}</span>{clash ? <Badge tone="destructive">Booked</Badge> : <Badge tone="success">Free</Badge>}</div><div className="text-xs text-muted-foreground">{titleCase(v.type)} · {f.setup_style.toLowerCase()} capacity {cap}{Number(f.expected_guests) > Number(cap) ? ' ⚠ over capacity' : ''} · {fmtMoney(v.full_day_rate, currency)}/day · {fmtMoney(v.hourly_rate, currency)}/h</div></button>; })}</div></div>}
    {step === 2 && <div className="space-y-2"><table className="w-full text-sm"><thead className="text-xs uppercase text-muted-foreground"><tr><th className="text-left w-32">Type</th><th className="text-left">Description</th><th className="w-20">Qty</th><th className="w-28">Unit price</th><th className="w-28 text-right">Total</th><th className="w-8" /></tr></thead><tbody>{items.map((it, i) => <tr key={i}><td className="p-1"><NativeSelect value={it.item_type} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, item_type: e.target.value } : x)))}>{ITEM_TYPES.map((t) => <option key={t}>{t}</option>)}</NativeSelect></td><td className="p-1"><Input value={it.description} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></td><td className="p-1"><Input type="number" value={it.quantity} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></td><td className="p-1"><Input type="number" step="0.01" value={it.unit_price} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, unit_price: e.target.value } : x)))} /></td><td className="p-1 text-right tabular">{fmtMoney(Number(it.quantity || 0) * Number(it.unit_price || 0), currency)}</td><td><Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setItems(items.filter((_, j) => j !== i))}>×</Button></td></tr>)}</tbody></table>
      <div className="flex justify-between items-center"><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setItems([...items, { item_type: 'MENU', description: '', quantity: f.expected_guests, unit_price: '' }])}>Add line</Button>{venue && <Button size="sm" variant="ghost" onClick={() => setItems([...items, { item_type: 'VENUE', description: `${venue.name} full day`, quantity: 1, unit_price: venue.full_day_rate }])}>+ venue rate</Button>}</div><div className="text-sm">Quotation total: <b>{fmtMoney(total, currency)}</b></div></div>
      <div className="grid grid-cols-3 gap-3"><div className="flex flex-col gap-1"><Label>Menu notes</Label><Textarea rows={2} value={f.menu_notes} onChange={(e) => set('menu_notes', e.target.value)} /></div><div className="flex flex-col gap-1"><Label>Equipment notes</Label><Textarea rows={2} value={f.equipment_notes} onChange={(e) => set('equipment_notes', e.target.value)} /></div><div className="flex flex-col gap-1"><Label>Staffing notes</Label><Textarea rows={2} value={f.staff_notes} onChange={(e) => set('staff_notes', e.target.value)} /></div></div></div>}
    {step === 3 && <KV items={[['Event', `${f.name} (${f.type})`], ['When', `${fmtDateTime(f.start_at)} → ${fmtDateTime(f.end_at)}`], ['Venue', venue?.name ?? 'TBD'], ['Guests', `${f.expected_guests} · ${f.setup_style}`], ['Quotation', fmtMoney(total, currency)], ['Deposit required', fmtMoney(f.deposit_required, currency)]]} />}
    <div className="mt-5 flex justify-between"><Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</Button>{step < 3 ? <Button disabled={step === 0 && f.name.length < 2} onClick={() => setStep(step + 1)}>Next</Button> : <Button loading={create.isPending} onClick={() => create.mutate(undefined as any)}><PartyPopper />Create event</Button>}</div>
  </Modal>;
}
export function EventsPage() {
  const { can } = useAuth(); const router = useRouter(); const [wiz, setWiz] = useState(false);
  const { data: cal } = useApi<any>('/events/calendar', { from: today(), to: addDays(today(), 60) });
  return <div className="space-y-4">
    <PageHeader title="Events & banquets" subtitle="Inquiries → quotations → confirmed events with BEO, event folio and invoicing." actions={can('events.manage') && <Button onClick={() => setWiz(true)}><CalendarPlus />New event</Button>} />
    <Tabs defaultValue="list"><TabsList><TabsTrigger value="list">All events</TabsTrigger><TabsTrigger value="upcoming">Next 60 days</TabsTrigger></TabsList>
      <TabsContent value="list"><DataTable path="/events" defaultSort="start_at" rowHref={(r) => `/events/${r.id}`} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['TENTATIVE', 'QUOTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] }, { key: 'type', label: 'Type', type: 'select', options: EVENT_TYPES }, { key: 'venue_id', label: 'Venue', type: 'select', source: '/venues' }]}
        columns={[{ key: 'number', label: 'No.' }, { key: 'name', label: 'Event', render: (r) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.customer_name ?? r.guest_name ?? r.contact_name}</div></div> }, { key: 'type', label: 'Type', render: (r) => titleCase(r.type) }, { key: 'venue_name', label: 'Venue' }, { key: 'start_at', label: 'Start', type: 'datetime' }, { key: 'end_at', label: 'End', type: 'datetime' }, { key: 'expected_guests', label: 'Pax', type: 'number', decimals: 0 }, { key: 'quotation_total', label: 'Quotation', type: 'money' }, { key: 'deposit_paid', label: 'Deposit', type: 'money' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} /></TabsContent>
      <TabsContent value="upcoming"><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{(Array.isArray(cal) ? cal : cal?.data ?? []).map((e: any) => <button type="button" key={e.id} onClick={() => router.push(`/events/${e.id}`)} className="rounded-lg border bg-card p-3 text-left hover:bg-accent"><div className="flex justify-between"><span className="font-medium">{e.name}</span><StatusBadge status={e.status} /></div><div className="text-xs text-muted-foreground">{fmtDateTime(e.start_at)} → {fmtDateTime(e.end_at)} · {e.venue_name ?? 'no venue'} · {e.expected_guests} pax</div></button>)}</div></TabsContent>
    </Tabs>
    <EventWizard open={wiz} onOpenChange={setWiz} onCreated={(e) => router.push(`/events/${e.id}`)} />
  </div>;
}
