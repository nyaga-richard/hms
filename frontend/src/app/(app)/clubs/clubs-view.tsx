'use client';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Ticket, Music4 } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { LookupSelect } from '@/components/shared/form';
import { fmtDate, fmtMoney, today, addDays } from '@/lib/utils';

/** Club night creation: one dialog with an inline ticket-type editor (kept short — details are edited on the event page). */
export function ClubEventDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (e: any) => void }) {
  const [f, setF] = useState<any>({ outlet_id: '', name: '', event_date: addDays(today(), 1), start_time: '21:00', end_time: '04:00', description: '', capacity: '', cover_charge: '', promotions: '' });
  const [types, setTypes] = useState<any[]>([{ name: 'Regular', price: '', quantity_available: '', includes: '' }, { name: 'VIP', price: '', quantity_available: '', includes: '' }]);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const create = useAction(() => post('/club-events', { ...f, capacity: f.capacity ? Number(f.capacity) : null, cover_charge: f.cover_charge ? Number(f.cover_charge) : 0, ticket_types: types.filter((t) => t.name && t.price !== '').map((t) => ({ name: t.name, price: Number(t.price), quantity_available: t.quantity_available ? Number(t.quantity_available) : null, includes: t.includes || null })) }), { success: 'Club night scheduled', invalidate: ['/club-events'], onSuccess: (e: any) => { onOpenChange(false); onCreated?.(e); } });
  return <Modal open={open} onOpenChange={onOpenChange} title="Schedule club night" size="lg"><div className="space-y-4">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="flex flex-col gap-1 col-span-2"><Label>Club / outlet</Label><LookupSelect source="/outlets" sourceQuery={{ type: 'CLUB' }} value={f.outlet_id} onChange={(v) => set('outlet_id', v)} placeholder="Select club" allowEmpty={false} /></div>
      <div className="flex flex-col gap-1 col-span-2"><Label>Event name</Label><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Saturday Afrobeats Night" /></div>
      <div className="flex flex-col gap-1"><Label>Date</Label><Input type="date" value={f.event_date} onChange={(e) => set('event_date', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Doors open</Label><Input type="time" value={f.start_time} onChange={(e) => set('start_time', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Closes</Label><Input type="time" value={f.end_time} onChange={(e) => set('end_time', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Capacity</Label><Input type="number" min={0} value={f.capacity} onChange={(e) => set('capacity', e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>Cover charge (walk-in)</Label><Input type="number" step="0.01" value={f.cover_charge} onChange={(e) => set('cover_charge', e.target.value)} /></div>
      <div className="flex flex-col gap-1 col-span-3"><Label>Promotions</Label><Input value={f.promotions} onChange={(e) => set('promotions', e.target.value)} placeholder="Ladies free before 11pm, 2-for-1 cocktails…" /></div>
      <div className="flex flex-col gap-1 col-span-4"><Label>Description</Label><Textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
    </div>
    <div><div className="flex items-center justify-between mb-1"><Label>Ticket types</Label><Button size="sm" variant="ghost" onClick={() => setTypes([...types, { name: '', price: '', quantity_available: '', includes: '' }])}><Plus />Add type</Button></div>
      <div className="space-y-2">{types.map((t, i) => <div key={i} className="grid grid-cols-12 gap-2"><Input className="col-span-3" placeholder="Name" value={t.name} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /><Input className="col-span-2" type="number" step="0.01" placeholder="Price" value={t.price} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} /><Input className="col-span-2" type="number" placeholder="Qty (blank = unlimited)" value={t.quantity_available} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, quantity_available: e.target.value } : x)))} /><Input className="col-span-4" placeholder="Includes (e.g. 1 bottle, table)" value={t.includes} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, includes: e.target.value } : x)))} /><Button size="icon" variant="ghost" className="col-span-1" onClick={() => setTypes(types.filter((_, j) => j !== i))}>×</Button></div>)}</div></div>
    <div className="flex justify-end"><Button loading={create.isPending} disabled={!f.outlet_id || f.name.length < 2} onClick={() => create.mutate(undefined as any)}><Music4 />Schedule</Button></div>
  </div></Modal>;
}
export function ClubsPage() {
  const { can, currency } = useAuth(); const router = useRouter(); const [open, setOpen] = useState(false);
  const { data: live } = useApi<any>('/club-events', { status: 'LIVE', pageSize: 5 });
  return <div className="space-y-4">
    <PageHeader title="Club nights & tickets" subtitle="Schedule events per club, sell tickets with QR check-in, manage guest lists and table reservations." actions={can('clubs.manage') && <Button onClick={() => setOpen(true)}><Plus />Schedule night</Button>} />
    {(live?.data ?? []).length > 0 && <div className="grid gap-3 md:grid-cols-3">{live.data.map((e: any) => <button type="button" key={e.id} onClick={() => router.push(`/clubs/${e.id}`)} className="rounded-lg border-2 border-emerald-500/60 bg-card p-3 text-left hover:bg-accent"><div className="flex justify-between"><span className="font-semibold">{e.name}</span><Badge tone="success">LIVE</Badge></div><div className="text-xs text-muted-foreground">{e.outlet_name} · {fmtDate(e.event_date)}</div><div className="mt-1 text-sm">{e.tickets_sold ?? 0} tickets · {e.checked_in ?? 0} in · {fmtMoney(e.ticket_revenue, currency)}</div></button>)}</div>}
    <DataTable path="/club-events" defaultSort="event_date" defaultOrder="desc" rowHref={(r) => `/clubs/${r.id}`} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['SCHEDULED', 'LIVE', 'CLOSED', 'CANCELLED'] }, { key: 'outlet_id', label: 'Club', type: 'select', source: '/outlets', sourceQuery: { type: 'CLUB' } }]}
      columns={[{ key: 'event_date', label: 'Date', type: 'date' }, { key: 'name', label: 'Event', render: (r) => <div><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.outlet_name} · {String(r.start_time).slice(0, 5)}–{String(r.end_time).slice(0, 5)}</div></div> }, { key: 'capacity', label: 'Capacity', type: 'number', decimals: 0 }, { key: 'cover_charge', label: 'Cover', type: 'money' }, { key: 'tickets_sold', label: 'Sold', type: 'number', decimals: 0 }, { key: 'checked_in', label: 'Checked in', type: 'number', decimals: 0 }, { key: 'guest_list_count', label: 'Guest list', type: 'number', decimals: 0 }, { key: 'ticket_revenue', label: 'Revenue', type: 'money' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
    <ClubEventDialog open={open} onOpenChange={setOpen} onCreated={(e) => router.push(`/clubs/${e.id}`)} />
  </div>;
}
