'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { get, post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { Modal } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { KV } from '@/components/shared/page';
import { fmtDate, fmtMoney, today, addDays, cn } from '@/lib/utils';
import { GuestPicker } from './guest-picker';
import { PaymentLineFields, type PaymentLine } from './payment-fields';

function Steps({ steps, current }: { steps: string[]; current: number }) {
  return <ol className="flex items-center gap-2 text-xs mb-4">{steps.map((s, i) => <li key={s} className="flex items-center gap-2"><span className={cn('flex h-5 w-5 items-center justify-center rounded-full border text-[10px]', i < current ? 'bg-primary text-primary-foreground border-primary' : i === current ? 'border-primary text-primary' : 'text-muted-foreground')}>{i < current ? <Check className="h-3 w-3" /> : i + 1}</span><span className={i === current ? 'font-medium' : 'text-muted-foreground'}>{s}</span>{i < steps.length - 1 && <span className="w-6 border-t" />}</li>)}</ol>;
}
export { Steps };

/** Check-in wizard: (reservation | walk-in details) → room assignment → registration & deposit → confirm. */
export function CheckInDialog({ open, onOpenChange, reservation, walkIn, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; reservation?: any; walkIn?: boolean; onDone?: (stay: any) => void }) {
  const router = useRouter(); const { currency } = useAuth();
  const [step, setStep] = useState(0);
  const [guest, setGuest] = useState<any>(null);
  const [wk, setWk] = useState<any>({ room_type_id: '', departure_date: addDays(today(), 1), adults: 1, children: 0, rate: '', rate_plan_id: '', meal_plan: 'RO', source: 'WALK_IN', customer_id: '' });
  const [roomId, setRoomId] = useState<string>(''); const [reg, setReg] = useState<any>({ id_type: '', id_number: '', vehicle: '', purpose: 'LEISURE', signature_name: '' });
  const [deposit, setDeposit] = useState<PaymentLine>({ amount: '' }); const [notes, setNotes] = useState(''); const [rate, setRate] = useState<string>('');
  const arrival = today(); const departure = walkIn ? wk.departure_date : reservation?.departure_date?.slice(0, 10); const roomTypeId = walkIn ? wk.room_type_id : reservation?.room_type_id;
  const { data: roomTypes } = useApi<any>('/room-types', { pageSize: 100 }, { enabled: open });
  const { data: ratePlans } = useApi<any>('/rate-plans', { pageSize: 100 }, { enabled: open && !!walkIn });
  const { data: avail } = useApi<any>('/reservations/availability', { arrival, departure, room_type_id: roomTypeId || undefined, exclude: reservation?.id }, { enabled: open && !!departure && step >= 1 });
  const [quote, setQuote] = useState<any>(null);
  useEffect(() => { if (open) { setStep(0); setGuest(reservation ? { id: reservation.guest_id, full_name: reservation.guest_name, phone: reservation.guest_phone, email: reservation.guest_email, vip_level: reservation.vip_level } : null); setRoomId(reservation?.room_id ?? ''); setRate(reservation?.rate ?? ''); setDeposit({ amount: '' }); setNotes(''); } }, [open, reservation]);
  useEffect(() => { if (!walkIn || !wk.room_type_id || !wk.departure_date) return; get('/reservations/quote', { room_type_id: wk.room_type_id, rate_plan_id: wk.rate_plan_id || undefined, arrival, departure: wk.departure_date, adults: wk.adults, children: wk.children }).then((q) => { setQuote(q); if (!wk.rate) setWk((w: any) => ({ ...w, rate: q.avg ?? '' })); }).catch(() => setQuote(null)); }, [walkIn, wk.room_type_id, wk.departure_date, wk.rate_plan_id, wk.adults, wk.children]); // eslint-disable-line
  const rooms: any[] = useMemo(() => (avail?.rooms ?? []).filter((r: any) => !roomTypeId || r.room_type_id === roomTypeId), [avail, roomTypeId]);
  const steps = walkIn ? ['Guest & stay', 'Room', 'Registration', 'Confirm'] : ['Reservation', 'Room', 'Registration', 'Confirm'];
  const doCheckIn = useAction(async () => {
    const body: any = { room_id: roomId, registration: reg, notes: notes || undefined, deposit: Number(deposit.amount) > 0 ? deposit : null };
    if (walkIn) body.walk_in = { guest_id: guest.id, room_type_id: wk.room_type_id, departure_date: wk.departure_date, adults: Number(wk.adults), children: Number(wk.children), rate: wk.rate === '' ? undefined : Number(wk.rate), rate_plan_id: wk.rate_plan_id || null, meal_plan: wk.meal_plan, source: wk.source, customer_id: wk.customer_id || null };
    else { body.reservation_id = reservation.id; if (rate !== '' && Number(rate) !== Number(reservation.rate)) body.rate = Number(rate); }
    return post('/checkins', body);
  }, { success: 'Guest checked in', invalidate: ['/stays', '/reservations', '/rooms', '/dashboard'], onSuccess: (r: any) => { onOpenChange(false); onDone?.(r); const sid = r?.stay?.id ?? r?.id; if (sid) router.push(`/front-office/stays/${sid}`); } });
  const canNext = step === 0 ? (walkIn ? guest && wk.room_type_id && wk.departure_date > arrival : true) : step === 1 ? !!roomId : true;
  const selRoom = rooms.find((r) => r.id === roomId); const roomType = (roomTypes?.data ?? []).find((t: any) => t.id === roomTypeId);
  return <Modal open={open} onOpenChange={onOpenChange} title={walkIn ? 'Walk-in check-in' : `Check in · ${reservation?.number ?? ''}`} size="xl">
    <Steps steps={steps} current={step} />
    {step === 0 && (walkIn ? <div className="space-y-4">
      <div><Label>Guest</Label><GuestPicker value={guest} onChange={setGuest} /></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="flex flex-col gap-1 col-span-2"><Label>Room type</Label><NativeSelect value={wk.room_type_id} onChange={(e) => setWk({ ...wk, room_type_id: e.target.value, rate: '' })}><option value="">Select…</option>{(roomTypes?.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name} · {fmtMoney(t.base_rate, currency)}</option>)}</NativeSelect></div>
        <div className="flex flex-col gap-1"><Label>Departure</Label><Input type="date" min={addDays(arrival, 1)} value={wk.departure_date} onChange={(e) => setWk({ ...wk, departure_date: e.target.value, rate: '' })} /></div>
        <div className="flex flex-col gap-1"><Label>Rate plan</Label><NativeSelect value={wk.rate_plan_id} onChange={(e) => setWk({ ...wk, rate_plan_id: e.target.value, rate: '' })}><option value="">Standard (BAR)</option>{(ratePlans?.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</NativeSelect></div>
        <div className="flex flex-col gap-1"><Label>Adults</Label><Input type="number" min={1} value={wk.adults} onChange={(e) => setWk({ ...wk, adults: e.target.value })} /></div>
        <div className="flex flex-col gap-1"><Label>Children</Label><Input type="number" min={0} value={wk.children} onChange={(e) => setWk({ ...wk, children: e.target.value })} /></div>
        <div className="flex flex-col gap-1"><Label>Rate / night</Label><Input type="number" step="0.01" value={wk.rate} onChange={(e) => setWk({ ...wk, rate: e.target.value })} placeholder={quote ? String(quote.avg ?? '') : ''} /></div>
        <div className="flex flex-col gap-1"><Label>Meal plan</Label><NativeSelect value={wk.meal_plan} onChange={(e) => setWk({ ...wk, meal_plan: e.target.value })}>{['RO', 'BB', 'HB', 'FB', 'AI'].map((m) => <option key={m}>{m}</option>)}</NativeSelect></div>
        <div className="flex flex-col gap-1 col-span-2"><Label>Source</Label><NativeSelect value={wk.source} onChange={(e) => setWk({ ...wk, source: e.target.value })}>{['WALK_IN', 'PHONE', 'EMAIL', 'WEBSITE', 'OTA', 'CORPORATE', 'AGENT'].map((m) => <option key={m}>{m.replace('_', ' ')}</option>)}</NativeSelect></div>
      </div>
      {quote && <div className="text-xs text-muted-foreground">Quote: {quote.nights?.length} night(s) · avg {fmtMoney(quote.avg, currency)} · total {fmtMoney(quote.total, currency)}</div>}
    </div> : <div className="space-y-3">
      <KV items={[['Guest', <span key="g">{reservation?.guest_name} {reservation?.vip_level > 0 && <Badge tone="warning">VIP {reservation.vip_level}</Badge>}</span>], ['Reservation', reservation?.number], ['Dates', `${fmtDate(reservation?.arrival_date)} → ${fmtDate(reservation?.departure_date)} (${reservation?.nights} nights)`], ['Room type', reservation?.room_type_name], ['Occupancy', `${reservation?.adults} adults, ${reservation?.children} children`], ['Company', reservation?.customer_name ?? '—'], ['Deposit paid', fmtMoney(reservation?.deposit_paid, currency)], ['Special requests', reservation?.special_requests ?? '—']]} />
      <div className="flex flex-col gap-1 max-w-xs"><Label>Rate per night</Label><Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /><span className="text-xs text-muted-foreground">Changing the rate at check-in is audited.</span></div>
    </div>)}
    {step === 1 && <div className="space-y-3">
      <div className="text-sm text-muted-foreground">Available {roomType?.name ?? ''} rooms for {fmtDate(arrival)} → {fmtDate(departure)}. Clean/inspected rooms are recommended; dirty rooms can be assigned but housekeeping will be alerted.</div>
      {rooms.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No free rooms of this type. Consider a room upgrade from the reservation page.</div> :
        <div className="grid grid-cols-3 md:grid-cols-5 gap-2">{rooms.map((r) => <button type="button" key={r.id} onClick={() => setRoomId(r.id)} className={cn('rounded-lg border p-3 text-left transition-colors hover:border-primary', roomId === r.id && 'border-primary bg-primary/5 ring-1 ring-primary')}><div className="text-lg font-semibold">{r.number}</div><div className="text-[11px] text-muted-foreground">{r.floor ? `Floor ${r.floor}` : ''}</div><Badge tone={r.housekeeping_status === 'INSPECTED' || r.housekeeping_status === 'CLEAN' ? 'success' : r.housekeeping_status === 'DIRTY' ? 'destructive' : 'warning'} className="mt-1">{r.housekeeping_status}</Badge></button>)}</div>}
    </div>}
    {step === 2 && <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1"><Label>ID type</Label><NativeSelect value={reg.id_type} onChange={(e) => setReg({ ...reg, id_type: e.target.value })}><option value="">—</option>{['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE', 'OTHER'].map((x) => <option key={x}>{x}</option>)}</NativeSelect></div>
      <div className="flex flex-col gap-1"><Label>ID number</Label><Input value={reg.id_number} onChange={(e) => setReg({ ...reg, id_number: e.target.value })} /></div>
      <div className="flex flex-col gap-1"><Label>Vehicle reg.</Label><Input value={reg.vehicle} onChange={(e) => setReg({ ...reg, vehicle: e.target.value })} /></div>
      <div className="flex flex-col gap-1"><Label>Purpose of visit</Label><NativeSelect value={reg.purpose} onChange={(e) => setReg({ ...reg, purpose: e.target.value })}>{['LEISURE', 'BUSINESS', 'CONFERENCE', 'TRANSIT', 'OTHER'].map((x) => <option key={x}>{x}</option>)}</NativeSelect></div>
      <div className="col-span-2 rounded-md border p-3"><div className="text-sm font-medium mb-2">Deposit / advance payment (optional)</div><PaymentLineFields value={deposit} onChange={setDeposit} /></div>
      <div className="col-span-2 flex flex-col gap-1"><Label>Registration card signed by</Label><Input value={reg.signature_name} onChange={(e) => setReg({ ...reg, signature_name: e.target.value })} placeholder="Guest name as signed" /></div>
      <div className="col-span-2 flex flex-col gap-1"><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
    </div>}
    {step === 3 && <KV items={[['Guest', guest?.full_name], ['Room', <span key="r">{selRoom?.number} <span className="text-muted-foreground">({roomType?.name})</span></span>], ['Stay', `${fmtDate(arrival)} → ${fmtDate(departure)}`], ['Rate', fmtMoney(walkIn ? wk.rate : rate || reservation?.rate, currency) + ' / night'], ['Deposit now', Number(deposit.amount) > 0 ? fmtMoney(deposit.amount, currency) : 'None'], ['Registration', [reg.id_type, reg.id_number].filter(Boolean).join(' ') || '—']]} />}
    <div className="mt-5 flex items-center justify-between"><Button type="button" variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}><ChevronLeft />Back</Button>
      {step < steps.length - 1 ? <Button type="button" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>Next<ChevronRight /></Button> : <Button type="button" loading={doCheckIn.isPending} onClick={() => doCheckIn.mutate(undefined as any)}><Check />Complete check-in</Button>}</div>
  </Modal>;
}
