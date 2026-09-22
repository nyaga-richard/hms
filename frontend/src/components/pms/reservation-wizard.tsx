'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { get, post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { Modal } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/misc';
import { Badge } from '@/components/ui/badge';
import { KV } from '@/components/shared/page';
import { LookupSelect } from '@/components/shared/form';
import { fmtDate, fmtMoney, today, addDays, cn, nightsBetween } from '@/lib/utils';
import { GuestPicker } from './guest-picker';
import { Steps } from './checkin-dialog';
import { PaymentLineFields, type PaymentLine } from './payment-fields';

type RoomLine = { room_type_id: string; rate_plan_id: string; adults: number; children: number; rate: string; room_id: string; quote?: any };
/** Reservation wizard: dates & availability → rooms & rates → guest & details → confirm (+ optional deposit). Handles group bookings via multiple room lines. */
export function ReservationWizard({ open, onOpenChange, defaultArrival, defaultRoomTypeId, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; defaultArrival?: string; defaultRoomTypeId?: string; onCreated?: (r: any) => void }) {
  const { currency, can } = useAuth();
  const [step, setStep] = useState(0);
  const [arrival, setArrival] = useState(defaultArrival ?? today()); const [departure, setDeparture] = useState(addDays(defaultArrival ?? today(), 1));
  const [lines, setLines] = useState<RoomLine[]>([]); const [guest, setGuest] = useState<any>(null);
  const [det, setDet] = useState<any>({ customer_id: '', source: 'PHONE', meal_plan: 'RO', status: 'CONFIRMED', special_requests: '', notes: '', eta: '', external_ref: '', deposit_required: '', allow_overbooking: false, group_name: '' });
  const [deposit, setDeposit] = useState<PaymentLine>({ amount: '' });
  const nights = nightsBetween(arrival, departure);
  const { data: avail, isFetching } = useApi<any>('/reservations/availability', { arrival, departure }, { enabled: open && nights > 0 });
  const { data: ratePlans } = useApi<any>('/rate-plans', { pageSize: 100 }, { enabled: open });
  useEffect(() => { if (open) { setStep(0); setLines(defaultRoomTypeId ? [{ room_type_id: defaultRoomTypeId, rate_plan_id: '', adults: 1, children: 0, rate: '', room_id: '' }] : []); setGuest(null); setDeposit({ amount: '' }); if (defaultArrival) { setArrival(defaultArrival); setDeparture(addDays(defaultArrival, 1)); } } }, [open]); // eslint-disable-line
  const summary: any[] = avail?.summary ?? avail?.room_types ?? (Array.isArray(avail) ? avail : []);
  const freeRooms: any[] = avail?.rooms ?? [];
  // fetch quotes for each line
  useEffect(() => { if (!open || nights <= 0) return; lines.forEach((l, i) => { if (!l.room_type_id) return; get('/reservations/quote', { room_type_id: l.room_type_id, rate_plan_id: l.rate_plan_id || undefined, arrival, departure, adults: l.adults, children: l.children }).then((q) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quote: q, rate: x.rate === '' ? String(q.avg ?? '') : x.rate } : x)))).catch(() => {}); }); }, [open, arrival, departure, lines.map((l) => `${l.room_type_id}|${l.rate_plan_id}|${l.adults}|${l.children}`).join(',')]); // eslint-disable-line
  const total = lines.reduce((s, l) => s + Number(l.rate || 0) * nights, 0);
  const addLine = (rtId: string) => setLines((ls) => [...ls, { room_type_id: rtId, rate_plan_id: '', adults: 1, children: 0, rate: '', room_id: '' }]);
  const create = useAction(async () => {
    const base = { guest_id: guest.id, customer_id: det.customer_id || null, arrival_date: arrival, departure_date: departure, meal_plan: det.meal_plan, source: det.source, status: det.status, special_requests: det.special_requests || undefined, notes: det.notes || undefined, eta: det.eta || undefined, external_ref: det.external_ref || undefined, deposit_required: det.deposit_required ? Number(det.deposit_required) : undefined, allow_overbooking: det.allow_overbooking || undefined };
    const rooms = lines.map((l) => ({ ...base, room_type_id: l.room_type_id, room_id: l.room_id || null, rate_plan_id: l.rate_plan_id || null, adults: Number(l.adults), children: Number(l.children), rate: l.rate === '' ? null : Number(l.rate) }));
    let created: any;
    if (rooms.length === 1) created = await post('/reservations', rooms[0]); else { const g = await post('/reservations/group', { rooms, group_name: det.group_name || undefined }); created = g.reservations?.[0] ?? g; }
    if (Number(deposit.amount) > 0 && deposit.payment_method_id && created?.id) await post(`/reservations/${created.id}/deposit`, deposit);
    return created;
  }, { success: 'Reservation created', invalidate: ['/reservations', '/dashboard'], onSuccess: (r: any) => { onOpenChange(false); onCreated?.(r); } });
  const steps = ['Dates & availability', 'Rooms & rates', 'Guest & details', 'Confirm'];
  const canNext = step === 0 ? nights > 0 && lines.length > 0 : step === 1 ? lines.every((l) => l.room_type_id && Number(l.adults) >= 1) : step === 2 ? !!guest : true;
  return <Modal open={open} onOpenChange={onOpenChange} title="New reservation" size="xl">
    <Steps steps={steps} current={step} />
    {step === 0 && <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 max-w-lg"><div className="flex flex-col gap-1"><Label>Arrival</Label><Input type="date" value={arrival} onChange={(e) => { setArrival(e.target.value); if (departure <= e.target.value) setDeparture(addDays(e.target.value, 1)); }} /></div><div className="flex flex-col gap-1"><Label>Departure</Label><Input type="date" min={addDays(arrival, 1)} value={departure} onChange={(e) => setDeparture(e.target.value)} /></div><div className="flex flex-col gap-1"><Label>Nights</Label><div className="h-9 flex items-center px-3 rounded-md border bg-muted/40 text-sm font-medium">{nights > 0 ? nights : '—'}</div></div></div>
      <div className="text-sm font-medium">Availability {isFetching && <span className="text-xs text-muted-foreground">(updating…)</span>}</div>
      <div className="grid gap-2 md:grid-cols-2">{summary.map((rt: any) => { const count = lines.filter((l) => l.room_type_id === rt.id).length; const soldOut = rt.available <= count; return <div key={rt.id} className={cn('rounded-lg border p-3 flex items-center justify-between', count > 0 && 'border-primary bg-primary/5')}><div><div className="font-medium">{rt.name} <span className="text-xs text-muted-foreground">{rt.code}</span></div><div className="text-xs text-muted-foreground">From {fmtMoney(rt.base_rate, currency)}/night · max {rt.max_adults}A {rt.max_children}C</div><div className="mt-1"><Badge tone={rt.available > 2 ? 'success' : rt.available > 0 ? 'warning' : 'destructive'}>{rt.available} of {rt.total_rooms} available</Badge></div></div><div className="flex items-center gap-2">{count > 0 && <Button type="button" size="icon" variant="outline" onClick={() => setLines((ls) => { const i = ls.map((l) => l.room_type_id).lastIndexOf(rt.id); return ls.filter((_, j) => j !== i); })}><Trash2 className="h-4 w-4" /></Button>}<span className="w-4 text-center text-sm font-semibold">{count || ''}</span><Button type="button" size="icon" disabled={soldOut && !can('reservations.overbook')} variant={soldOut ? 'outline' : 'default'} onClick={() => addLine(rt.id)}><Plus className="h-4 w-4" /></Button></div></div>; })}</div>
      {lines.some((l) => { const rt = summary.find((s: any) => s.id === l.room_type_id); return rt && rt.available < lines.filter((x) => x.room_type_id === l.room_type_id).length; }) && <label className="flex items-center gap-2 text-sm text-amber-700"><Switch checked={det.allow_overbooking} onCheckedChange={(v) => setDet({ ...det, allow_overbooking: v })} /> Authorize overbooking (requires permission; audited)</label>}
    </div>}
    {step === 1 && <div className="space-y-3">{lines.map((l, i) => { const rt = summary.find((s: any) => s.id === l.room_type_id); const rooms = freeRooms.filter((r: any) => r.room_type_id === l.room_type_id && !lines.some((x, j) => j !== i && x.room_id === r.id)); return <div key={i} className="rounded-lg border p-3 grid grid-cols-2 md:grid-cols-6 gap-3 items-end"><div className="col-span-2 md:col-span-6 flex items-center justify-between"><div className="font-medium">Room {i + 1}: {rt?.name}</div>{l.quote && <div className="text-xs text-muted-foreground">Quote {fmtMoney(l.quote.total, currency)} for {nights} night(s)</div>}</div>
      <div className="flex flex-col gap-1 col-span-2"><Label>Rate plan</Label><NativeSelect value={l.rate_plan_id} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, rate_plan_id: e.target.value, rate: '' } : x)))}><option value="">Standard (BAR)</option>{(ratePlans?.data ?? []).filter((p: any) => !p.room_type_id || p.room_type_id === l.room_type_id).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</NativeSelect></div>
      <div className="flex flex-col gap-1"><Label>Adults</Label><Input type="number" min={1} max={rt?.max_adults} value={l.adults} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, adults: Number(e.target.value) } : x)))} /></div>
      <div className="flex flex-col gap-1"><Label>Children</Label><Input type="number" min={0} value={l.children} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, children: Number(e.target.value) } : x)))} /></div>
      <div className="flex flex-col gap-1"><Label>Rate / night</Label><Input type="number" step="0.01" value={l.rate} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} /></div>
      <div className="flex flex-col gap-1"><Label>Assign room</Label><NativeSelect value={l.room_id} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, room_id: e.target.value } : x)))}><option value="">Auto at check-in</option>{rooms.map((r: any) => <option key={r.id} value={r.id}>{r.number}{r.floor ? ` (F${r.floor})` : ''}</option>)}</NativeSelect></div></div>; })}
      <div className="text-right text-sm">Estimated total: <b>{fmtMoney(total, currency)}</b></div></div>}
    {step === 2 && <div className="space-y-4">
      <div><Label>Guest (primary)</Label><GuestPicker value={guest} onChange={setGuest} /></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="flex flex-col gap-1 col-span-2"><Label>Company / corporate account</Label><LookupSelect source="/customers" value={det.customer_id} onChange={(v: any) => setDet({ ...det, customer_id: v })} placeholder="None (individual)" /></div>
        <div className="flex flex-col gap-1"><Label>Source</Label><NativeSelect value={det.source} onChange={(e) => setDet({ ...det, source: e.target.value })}>{['PHONE', 'WALK_IN', 'EMAIL', 'WEBSITE', 'OTA', 'CORPORATE', 'AGENT'].map((m) => <option key={m}>{m}</option>)}</NativeSelect></div>
        <div className="flex flex-col gap-1"><Label>Meal plan</Label><NativeSelect value={det.meal_plan} onChange={(e) => setDet({ ...det, meal_plan: e.target.value })}>{['RO', 'BB', 'HB', 'FB', 'AI'].map((m) => <option key={m}>{m}</option>)}</NativeSelect></div>
        <div className="flex flex-col gap-1"><Label>Status</Label><NativeSelect value={det.status} onChange={(e) => setDet({ ...det, status: e.target.value })}>{['INQUIRY', 'TENTATIVE', 'CONFIRMED'].map((m) => <option key={m}>{m}</option>)}</NativeSelect></div>
        <div className="flex flex-col gap-1"><Label>ETA</Label><Input type="time" value={det.eta} onChange={(e) => setDet({ ...det, eta: e.target.value })} /></div>
        <div className="flex flex-col gap-1"><Label>Deposit required</Label><Input type="number" step="0.01" value={det.deposit_required} onChange={(e) => setDet({ ...det, deposit_required: e.target.value })} /></div>
        <div className="flex flex-col gap-1"><Label>External ref (OTA / voucher)</Label><Input value={det.external_ref} onChange={(e) => setDet({ ...det, external_ref: e.target.value })} /></div>
        {lines.length > 1 && <div className="flex flex-col gap-1 col-span-2"><Label>Group name</Label><Input value={det.group_name} onChange={(e) => setDet({ ...det, group_name: e.target.value })} placeholder="e.g. Acme Sales Conference" /></div>}
        <div className="flex flex-col gap-1 col-span-2"><Label>Special requests</Label><Textarea rows={2} value={det.special_requests} onChange={(e) => setDet({ ...det, special_requests: e.target.value })} /></div>
        <div className="flex flex-col gap-1 col-span-2"><Label>Internal notes</Label><Textarea rows={2} value={det.notes} onChange={(e) => setDet({ ...det, notes: e.target.value })} /></div>
      </div>
      {can('payments.create') && <div className="rounded-md border p-3"><div className="text-sm font-medium mb-2">Collect deposit now (optional)</div><PaymentLineFields value={deposit} onChange={setDeposit} /></div>}
    </div>}
    {step === 3 && <div className="space-y-3"><KV items={[['Guest', guest?.full_name], ['Company', det.customer_id ? 'Corporate account' : '—'], ['Dates', `${fmtDate(arrival)} → ${fmtDate(departure)} · ${nights} night(s)`], ['Rooms', lines.map((l) => `${summary.find((s: any) => s.id === l.room_type_id)?.name} (${l.adults}A/${l.children}C @ ${fmtMoney(l.rate, currency)})`).join('; ')], ['Estimated total', fmtMoney(total, currency)], ['Status', det.status], ['Deposit now', Number(deposit.amount) > 0 ? fmtMoney(deposit.amount, currency) : 'None']]} /></div>}
    <div className="mt-5 flex items-center justify-between"><Button type="button" variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}><ChevronLeft />Back</Button>{step < 3 ? <Button type="button" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>Next<ChevronRight /></Button> : <Button type="button" loading={create.isPending} onClick={() => create.mutate(undefined as any)}><Check />Create reservation</Button>}</div>
  </Modal>;
}
