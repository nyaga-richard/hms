'use client';
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, CalendarPlus } from 'lucide-react';
import { useApi } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/input';
import { cn, addDays, today, fmtDate, nightsBetween } from '@/lib/utils';
import { ReservationWizard } from '@/components/pms/reservation-wizard';

const COLORS: Record<string, string> = { CHECKED_IN: 'bg-sky-500 text-white', CONFIRMED: 'bg-emerald-500 text-white', DEPOSIT_PAID: 'bg-emerald-600 text-white', TENTATIVE: 'bg-amber-400 text-black', INQUIRY: 'bg-amber-200 text-black' };
/** Room-plan / tape chart: rooms × days with reservation bars; click an empty cell to start a booking. */
export default function CalendarPage() {
  const { can } = useAuth(); const [start, setStart] = useState(addDays(today(), -2)); const [days, setDays] = useState(14); const [rt, setRt] = useState(''); const [wiz, setWiz] = useState<{ open: boolean; arrival?: string; rtId?: string }>({ open: false });
  const end = addDays(start, days); const { data, isLoading } = useApi<any>('/reservations/calendar', { from: start, to: end, room_type_id: rt || undefined });
  const dates = useMemo(() => Array.from({ length: days }, (_, i) => addDays(start, i)), [start, days]);
  const rooms: any[] = data?.rooms ?? []; const res: any[] = data?.reservations ?? []; const blocks: any[] = data?.blocks ?? [];
  const types = Array.from(new Map(rooms.map((r) => [r.room_type_id, r.room_type_name])).entries());
  const unassigned = res.filter((r) => !r.room_id);
  const colW = 72; const t = today();
  return <div className="space-y-4">
    <PageHeader title="Room calendar" subtitle="Tape chart: each bar spans arrival → departure night. Click an empty cell to book." actions={<>{can('reservations.create') && <Button onClick={() => setWiz({ open: true })}><CalendarPlus />New reservation</Button>}</>} />
    <div className="flex flex-wrap items-center gap-2"><Button size="icon" variant="outline" onClick={() => setStart(addDays(start, -7))}><ChevronLeft className="h-4 w-4" /></Button><Button size="sm" variant="outline" onClick={() => setStart(addDays(today(), -2))}>Today</Button><Button size="icon" variant="outline" onClick={() => setStart(addDays(start, 7))}><ChevronRight className="h-4 w-4" /></Button><input type="date" className="h-8 rounded-md border bg-background px-2 text-sm" value={start} onChange={(e) => setStart(e.target.value)} /><NativeSelect className="h-8 w-28 text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 21, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</NativeSelect><NativeSelect className="h-8 w-44 text-xs" value={rt} onChange={(e) => setRt(e.target.value)}><option value="">All room types</option>{types.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</NativeSelect>
      <div className="ml-auto flex gap-2 text-[11px]">{Object.entries(COLORS).map(([k, c]) => <span key={k} className="flex items-center gap-1"><span className={cn('h-3 w-3 rounded', c)} />{k.replace('_', ' ')}</span>)}<span className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-slate-400" />Blocked</span></div></div>
    {isLoading ? <Spinner /> : <div className="overflow-auto rounded-lg border bg-card"><div style={{ minWidth: 140 + colW * days }}>
      <div className="flex sticky top-0 z-10 bg-muted/80 backdrop-blur border-b text-[11px]"><div className="w-[140px] shrink-0 px-2 py-1 font-medium">Room</div>{dates.map((d) => <div key={d} className={cn('shrink-0 border-l px-1 py-1 text-center', d === t && 'bg-primary/10 font-semibold')} style={{ width: colW }}>{new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' })}<br />{d.slice(5)}</div>)}</div>
      {rooms.map((room) => { const rres = res.filter((r) => r.room_id === room.id); const rblocks = blocks.filter((b) => b.room_id === room.id); return <div key={room.id} className="relative flex border-b h-10 hover:bg-accent/30"><div className="w-[140px] shrink-0 px-2 py-1 text-sm border-r"><b>{room.number}</b> <span className="text-[10px] text-muted-foreground">{room.room_type_name}</span></div>
        {dates.map((d) => <button type="button" key={d} className={cn('shrink-0 border-l h-full', d === t && 'bg-primary/5')} style={{ width: colW }} onClick={() => can('reservations.create') && setWiz({ open: true, arrival: d, rtId: room.room_type_id })} aria-label={`Book ${room.number} on ${d}`} />)}
        {rres.map((r) => { const a = r.arrival_date.slice(0, 10), dep = r.departure_date.slice(0, 10); const off = Math.max(0, nightsBetween(start, a)); const len = Math.min(nightsBetween(a < start ? start : a, dep > end ? end : dep), days - off); if (len <= 0) return null; return <Link key={r.id} href={`/front-office/reservations/${r.id}`} className={cn('absolute top-1.5 h-7 rounded px-2 text-[11px] leading-7 truncate shadow-sm', COLORS[r.status] ?? 'bg-slate-500 text-white')} style={{ left: 140 + off * colW + (a < start ? 0 : colW / 2), width: len * colW - (a < start ? colW / 2 : colW) + (dep > end ? colW / 2 : 0) }} title={`${r.guest_name} · ${r.number} · ${fmtDate(a)} → ${fmtDate(dep)}`}>{r.guest_name}</Link>; })}
        {rblocks.map((b) => { const a = String(b.start_date).slice(0, 10), e = addDays(String(b.end_date).slice(0, 10), 1); const off = Math.max(0, nightsBetween(start, a)); const len = Math.min(nightsBetween(a < start ? start : a, e > end ? end : e), days - off); if (len <= 0) return null; return <div key={b.id} className="absolute top-1.5 h-7 rounded bg-slate-400/80 px-2 text-[11px] leading-7 text-white truncate" style={{ left: 140 + off * colW, width: len * colW }} title={`${b.block_type}: ${b.reason}`}>{b.block_type} · {b.reason}</div>; })}
      </div>; })}
    </div></div>}
    {unassigned.length > 0 && <div className="rounded-lg border bg-card p-3 text-sm"><div className="font-medium mb-1">Unassigned reservations in range ({unassigned.length})</div><div className="flex flex-wrap gap-2">{unassigned.map((r) => <Link key={r.id} href={`/front-office/reservations/${r.id}`} className={cn('rounded px-2 py-1 text-[11px]', COLORS[r.status] ?? 'bg-slate-500 text-white')}>{r.guest_name} · {r.room_type_name} · {fmtDate(r.arrival_date)}→{fmtDate(r.departure_date)}</Link>)}</div></div>}
    <ReservationWizard open={wiz.open} onOpenChange={(o) => setWiz((w) => ({ ...w, open: o }))} defaultArrival={wiz.arrival} defaultRoomTypeId={wiz.rtId} />
  </div>;
}
