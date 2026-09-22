'use client';
import React, { useState } from 'react';
import { CalendarPlus, CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { ResourcePage } from '@/components/shared/resource-page';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { LookupSelect, ConfirmDialog } from '@/components/shared/form';
import { GuestPicker } from '@/components/pms/guest-picker';
import { PaymentLineFields, type PaymentLine } from '@/components/pms/payment-fields';
import { fmtDateTime, fmtMoney, fmtTime, today, addDays, titleCase } from '@/lib/utils';

const CATEGORIES = ['SPA', 'MASSAGE', 'SALON', 'GYM', 'POOL', 'TOUR', 'TRANSPORT', 'BUSINESS_CENTRE', 'OTHER'];
/** Booking dialog: service → who (in-house stay / guest / walk-in) → slot & resource → settlement. */
function BookingDialog({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (o: boolean) => void; initial?: Partial<any> }) {
  const { currency, can } = useAuth();
  const [f, setF] = useState<any>({ service_id: '', stay_id: '', customer_name: '', resource_id: '', staff_employee_id: '', start_at: `${today()}T10:00`, quantity: 1, discount: '', settlement: 'LATER', notes: '', ...initial });
  const [guest, setGuest] = useState<any>(null);
  const { data: services } = useApi<any>('/services', { pageSize: 200, is_active: true }, { enabled: open });
  const { data: inhouse } = useApi<any>('/stays', { status: 'IN_HOUSE', pageSize: 200 }, { enabled: open });
  const svc = (services?.data ?? []).find((s: any) => s.id === f.service_id); const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const total = svc ? Number(svc.price) * Number(f.quantity || 1) - Number(f.discount || 0) : 0;
  const create = useAction(() => post('/service-bookings', { ...f, guest_id: guest?.id ?? null, stay_id: f.stay_id || null, resource_id: f.resource_id || null, staff_employee_id: f.staff_employee_id || null, quantity: Number(f.quantity), discount: Number(f.discount || 0), customer_name: f.customer_name || guest?.full_name || null }), { success: 'Booking created', invalidate: ['/service-bookings'], onSuccess: () => onOpenChange(false) });
  return <Modal open={open} onOpenChange={onOpenChange} title="New service booking" size="lg"><div className="space-y-4">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="flex flex-col gap-1 col-span-2"><Label>Service</Label><NativeSelect value={f.service_id} onChange={(e) => set('service_id', e.target.value)}><option value="">Select service…</option>{(services?.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name} · {fmtMoney(s.price, currency)} · {s.duration_minutes} min</option>)}</NativeSelect></div>
      <div className="flex flex-col gap-1"><Label>Start</Label><Input type="datetime-local" value={f.start_at} onChange={(e) => set('start_at', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Quantity</Label><Input type="number" min={1} value={f.quantity} onChange={(e) => set('quantity', e.target.value)} /></div>
      <div className="flex flex-col gap-1 col-span-2"><Label>In-house stay (for room charge)</Label><NativeSelect value={f.stay_id} onChange={(e) => set('stay_id', e.target.value)}><option value="">Not a hotel guest / walk-in</option>{(inhouse?.data ?? []).map((s: any) => <option key={s.id} value={s.id}>Room {s.room_number} · {s.guest_name}</option>)}</NativeSelect></div>
      {!f.stay_id && <div className="flex flex-col gap-1 col-span-2"><Label>Guest profile (optional)</Label><GuestPicker value={guest} onChange={setGuest} /></div>}
      {!f.stay_id && !guest && <div className="flex flex-col gap-1 col-span-2"><Label>Walk-in name</Label><Input value={f.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></div>}
      <div className="flex flex-col gap-1 col-span-2"><Label>Room / resource</Label><LookupSelect source="/service-resources" value={f.resource_id} onChange={(v) => set('resource_id', v)} placeholder="Any available" /></div>
      <div className="flex flex-col gap-1 col-span-2"><Label>Therapist / staff</Label><LookupSelect source="/employees" sourceLabel="full_name" value={f.staff_employee_id} onChange={(v) => set('staff_employee_id', v)} placeholder="Unassigned" /></div>
      <div className="flex flex-col gap-1"><Label>Discount</Label><Input type="number" step="0.01" value={f.discount} disabled={!can('folios.discount', 'pos.discount')} onChange={(e) => set('discount', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Settlement</Label><NativeSelect value={f.settlement} onChange={(e) => set('settlement', e.target.value)}><option value="LATER">Decide at completion</option><option value="ROOM" disabled={!f.stay_id}>Charge to room</option><option value="PAY_NOW">Pay now (at completion)</option><option value="COMPLIMENTARY" disabled={!can('folios.discount', 'pos.discount')}>Complimentary</option></NativeSelect></div>
      <div className="flex flex-col gap-1 col-span-2"><Label>Notes</Label><Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Preferences, allergies, pickup point…" /></div>
    </div>
    <div className="flex items-center justify-between border-t pt-3"><span className="text-sm">{svc ? `${svc.duration_minutes} min · ` : ''}Total <b>{fmtMoney(total, currency)}</b></span><Button loading={create.isPending} disabled={!f.service_id} onClick={() => create.mutate(undefined as any)}><CalendarPlus />Book</Button></div>
  </div></Modal>;
}
/** Daily schedule grid: resources as rows, bookings placed along a 06:00–22:00 time axis. */
function Schedule({ onSelect }: { onSelect: (b: any) => void }) {
  const [date, setDate] = useState(today()); const { data } = useApi<any>('/service-bookings/schedule', { date });
  const H0 = 6, H1 = 22, span = H1 - H0; const pos = (iso: string) => { const d = new Date(iso); return ((d.getHours() + d.getMinutes() / 60 - H0) / span) * 100; };
  const rows = [...(data?.resources ?? []), { id: null, name: 'Unassigned', type: '' }];
  return <div className="space-y-2">
    <div className="flex items-center gap-2"><Button size="icon" variant="outline" onClick={() => setDate(addDays(date, -1))}><ChevronLeft /></Button><Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} /><Button size="icon" variant="outline" onClick={() => setDate(addDays(date, 1))}><ChevronRight /></Button><Button size="sm" variant="ghost" onClick={() => setDate(today())}>Today</Button><span className="text-sm text-muted-foreground">{(data?.bookings ?? []).length} bookings</span></div>
    <div className="overflow-x-auto rounded-lg border"><div className="min-w-[900px]">
      <div className="grid text-[10px] text-muted-foreground border-b" style={{ gridTemplateColumns: '160px 1fr' }}><div /><div className="relative h-5">{Array.from({ length: span + 1 }).map((_, i) => <span key={i} className="absolute -translate-x-1/2" style={{ left: `${(i / span) * 100}%` }}>{String(H0 + i).padStart(2, '0')}</span>)}</div></div>
      {rows.map((r: any) => { const bs = (data?.bookings ?? []).filter((b: any) => (b.resource_id ?? null) === r.id); return <div key={r.id ?? 'none'} className="grid border-b last:border-0" style={{ gridTemplateColumns: '160px 1fr' }}><div className="px-2 py-2 text-sm border-r"><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{titleCase(r.type ?? '')}</div></div><div className="relative h-14 bg-[repeating-linear-gradient(90deg,transparent,transparent_calc(100%/16-1px),hsl(var(--border))_calc(100%/16-1px),hsl(var(--border))_calc(100%/16))]">{bs.map((b: any) => { const l = pos(b.start_at), w = Math.max(2, pos(b.end_at) - l); const tone = b.status === 'COMPLETED' ? 'bg-emerald-500/80' : b.status === 'IN_PROGRESS' ? 'bg-amber-500/90' : b.status === 'NO_SHOW' ? 'bg-muted-foreground/50' : 'bg-primary/80'; return <button type="button" key={b.id} onClick={() => onSelect(b)} className={`absolute top-1.5 h-11 overflow-hidden rounded px-1.5 text-left text-[11px] leading-tight text-white ${tone}`} style={{ left: `${l}%`, width: `${w}%` }} title={`${b.service_name} · ${b.guest_name ?? b.customer_name ?? ''}`}><div className="font-medium truncate">{b.service_name}</div><div className="truncate opacity-90">{fmtTime(b.start_at)} · {b.guest_name ?? b.customer_name ?? 'Walk-in'}{b.room_number ? ` · Rm ${b.room_number}` : ''}</div><div className="truncate opacity-75">{b.staff_name ?? ''}</div></button>; })}</div></div>; })}
    </div></div></div>;
}
function BookingDetail({ booking, onClose }: { booking: any | null; onClose: () => void }) {
  const { can, currency } = useAuth(); const { data: b, refetch } = useApi<any>(booking ? `/service-bookings/${booking.id}` : null);
  const [complete, setComplete] = useState(false); const [settlement, setSettlement] = useState<'ROOM' | 'PAY_NOW' | 'COMPLIMENTARY'>('PAY_NOW'); const [pay, setPay] = useState<PaymentLine>({ amount: '' }); const [tip, setTip] = useState(''); const [statusTo, setStatusTo] = useState<string | null>(null);
  const inv = ['/service-bookings', '/folios', '/payments'];
  const statusM = useAction((v: any) => post(`/service-bookings/${booking.id}/status`, { status: statusTo, reason: v?.reason }), { success: 'Updated', invalidate: inv, onSuccess: () => { setStatusTo(null); refetch(); } });
  const completeM = useAction(() => post(`/service-bookings/${booking.id}/complete`, { settlement, payment_method_id: settlement === 'PAY_NOW' ? pay.payment_method_id : undefined, reference: pay.reference, tip: Number(tip || 0) }), { success: 'Service completed & settled', invalidate: inv, onSuccess: () => { setComplete(false); onClose(); } });
  if (!booking) return null; const x = b ?? booking;
  return <Modal open={!!booking} onOpenChange={(o) => !o && onClose()} title={<span className="flex items-center gap-2">{x.number} <StatusBadge status={x.status} /></span>} size="md"><div className="space-y-3">
    <KV items={[['Service', x.service_name], ['When', `${fmtDateTime(x.start_at)} → ${fmtTime(x.end_at)}`], ['Client', x.guest_name ?? x.customer_name ?? 'Walk-in'], ['Room', x.room_number ?? '—'], ['Resource', x.resource_name ?? '—'], ['Staff', x.staff_name ?? '—'], ['Quantity', x.quantity], ['Total', fmtMoney(x.total, currency)], ['Settlement', titleCase(x.settlement ?? '')], ['Notes', x.notes ?? '—']]} />
    {can('services.book') && !complete && <div className="flex flex-wrap gap-2 border-t pt-3">{['CONFIRMED', 'IN_PROGRESS'].includes(x.status) && <Button onClick={() => { setSettlement(x.settlement === 'LATER' ? (x.stay_id ? 'ROOM' : 'PAY_NOW') : x.settlement); setComplete(true); }}><CheckCircle2 />Complete & settle</Button>}{x.status === 'CONFIRMED' && <Button variant="outline" onClick={() => setStatusTo('IN_PROGRESS')}>Start</Button>}{['CONFIRMED'].includes(x.status) && <Button variant="outline" onClick={() => setStatusTo('NO_SHOW')}>No-show</Button>}{['CONFIRMED', 'IN_PROGRESS'].includes(x.status) && <Button variant="destructive" onClick={() => setStatusTo('CANCELLED')}>Cancel</Button>}</div>}
    {complete && <div className="space-y-3 rounded-lg border p-3"><Label>Settle as</Label><div className="flex gap-1">{(['PAY_NOW', 'ROOM', 'COMPLIMENTARY'] as const).map((s) => <Button key={s} size="sm" variant={settlement === s ? 'default' : 'outline'} disabled={(s === 'ROOM' && !x.stay_id) || (s === 'COMPLIMENTARY' && !can('folios.discount', 'pos.discount'))} onClick={() => setSettlement(s)}>{s === 'PAY_NOW' ? 'Pay now' : s === 'ROOM' ? `Room ${x.room_number ?? ''}` : 'Complimentary'}</Button>)}</div>
      {settlement === 'PAY_NOW' && <><PaymentLineFields value={{ ...pay, amount: String(Number(x.total) + Number(tip || 0)) }} onChange={setPay} showAmount={false} /><div className="flex flex-col gap-1"><Label>Tip</Label><Input type="number" step="0.01" value={tip} onChange={(e) => setTip(e.target.value)} /></div></>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setComplete(false)}>Back</Button><Button loading={completeM.isPending} disabled={settlement === 'PAY_NOW' && !pay.payment_method_id} onClick={() => completeM.mutate(undefined as any)}>Confirm {fmtMoney(settlement === 'COMPLIMENTARY' ? 0 : Number(x.total) + Number(tip || 0), currency)}</Button></div></div>}
    <ConfirmDialog open={!!statusTo} onOpenChange={(o) => !o && setStatusTo(null)} title={`Mark ${titleCase(statusTo ?? '')}?`} destructive={statusTo === 'CANCELLED'} fields={statusTo === 'CANCELLED' || statusTo === 'NO_SHOW' ? [{ name: 'reason', label: 'Reason' }] : []} onConfirm={(v) => statusM.mutateAsync(v)} />
  </div></Modal>;
}
export default function ServicesPage() {
  const { can } = useAuth(); const [book, setBook] = useState(false); const [sel, setSel] = useState<any>(null);
  return <div className="space-y-4">
    <PageHeader title="Spa & services" subtitle="Spa, salon, gym, tours and transport — book against in-house rooms or walk-ins, schedule rooms and therapists." actions={can('services.book') && <Button onClick={() => setBook(true)}><CalendarPlus />New booking</Button>} />
    <Tabs defaultValue="schedule"><TabsList><TabsTrigger value="schedule">Schedule</TabsTrigger><TabsTrigger value="bookings">Bookings</TabsTrigger><TabsTrigger value="services">Services</TabsTrigger><TabsTrigger value="resources">Rooms & resources</TabsTrigger></TabsList>
      <TabsContent value="schedule"><Schedule onSelect={setSel} /></TabsContent>
      <TabsContent value="bookings"><DataTable path="/service-bookings" defaultSort="start_at" onRowClick={setSel} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] }, { key: 'service_id', label: 'Service', type: 'select', source: '/services' }, { key: 'resource_id', label: 'Resource', type: 'select', source: '/service-resources' }]}
        columns={[{ key: 'number', label: 'No.' }, { key: 'start_at', label: 'Start', type: 'datetime' }, { key: 'service_name', label: 'Service' }, { key: 'guest_name', label: 'Client', render: (r) => r.guest_name ?? r.customer_name ?? 'Walk-in' }, { key: 'room_number', label: 'Room' }, { key: 'resource_name', label: 'Resource' }, { key: 'staff_name', label: 'Staff' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'settlement', label: 'Settlement', render: (r) => titleCase(r.settlement) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} /></TabsContent>
      <TabsContent value="services"><ResourcePage title="Services catalogue" path="/services" permissions={{ create: 'services.manage', edit: 'services.manage', delete: 'services.manage' }} embedded
        columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Service' }, { key: 'category', label: 'Category' }, { key: 'duration_minutes', label: 'Minutes', type: 'number', decimals: 0 }, { key: 'price', label: 'Price', type: 'money' }, { key: 'tax_name', label: 'Tax' }, { key: 'outlet_name', label: 'Outlet' }, { key: 'requires_staff', label: 'Staff', type: 'bool' }, { key: 'is_active', label: 'Active', type: 'bool' }]}
        fields={[{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, default: 'SPA' }, { name: 'duration_minutes', label: 'Duration (min)', type: 'number', default: 60 }, { name: 'price', label: 'Price', type: 'money', required: true }, { name: 'tax_id', label: 'Tax', type: 'lookup', source: '/taxes' }, { name: 'revenue_account_id', label: 'Revenue account', type: 'lookup', source: '/accounts', sourceQuery: { type: 'REVENUE' }, sourceLabel: (a: any) => `${a.code} ${a.name}` }, { name: 'outlet_id', label: 'Outlet (for department/store)', type: 'lookup', source: '/outlets' }, { name: 'folio_category', label: 'Folio category', placeholder: 'SPA' }, { name: 'capacity', label: 'Capacity per slot', type: 'number', default: 1 }, { name: 'requires_staff', label: 'Requires staff', type: 'switch' }, { name: 'is_active', label: 'Active', type: 'switch', default: true }, { name: 'description', label: 'Description', type: 'textarea', col: 2 }]} /></TabsContent>
      <TabsContent value="resources"><ResourcePage title="Treatment rooms, vehicles & equipment" path="/service-resources" permissions={{ create: 'services.manage', edit: 'services.manage', delete: 'services.manage' }} embedded
        columns={[{ key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'employee_name', label: 'Linked staff' }, { key: 'is_active', label: 'Active', type: 'bool' }]}
        fields={[{ name: 'name', label: 'Name', required: true }, { name: 'type', label: 'Type', type: 'select', options: ['ROOM', 'CHAIR', 'VEHICLE', 'EQUIPMENT', 'COURT', 'OTHER'], default: 'ROOM' }, { name: 'employee_id', label: 'Linked staff member', type: 'lookup', source: '/employees', sourceLabel: 'full_name' }, { name: 'is_active', label: 'Active', type: 'switch', default: true }]} /></TabsContent>
    </Tabs>
    <BookingDialog open={book} onOpenChange={setBook} />
    <BookingDetail booking={sel} onClose={() => setSel(null)} />
  </div>;
}
