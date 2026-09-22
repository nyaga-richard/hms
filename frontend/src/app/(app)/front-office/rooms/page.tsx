'use client';
import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { LayoutGrid, List, Ban, Unlock } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, KV } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/input';
import { FormDialog, ConfirmDialog } from '@/components/shared/form';
import { Modal } from '@/components/ui/dialog';
import { cn, fmtDate, fmtMoney, titleCase, today, addDays } from '@/lib/utils';

const STATUS_COLORS: Record<string, string> = { AVAILABLE: 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30', OCCUPIED: 'border-sky-400 bg-sky-50 dark:bg-sky-950/30', RESERVED: 'border-violet-400 bg-violet-50 dark:bg-violet-950/30', OUT_OF_ORDER: 'border-red-400 bg-red-50 dark:bg-red-950/30', OUT_OF_SERVICE: 'border-orange-400 bg-orange-50 dark:bg-orange-950/30', BLOCKED: 'border-slate-400 bg-slate-100 dark:bg-slate-900/40' };
const HK_DOT: Record<string, string> = { CLEAN: 'bg-emerald-500', INSPECTED: 'bg-emerald-700', DIRTY: 'bg-red-500', CLEANING: 'bg-amber-500', OUT_OF_ORDER: 'bg-slate-500' };
/** Live room rack: status + housekeeping at a glance; block/unblock and quick housekeeping updates. */
export default function RoomsRackPage() {
  const { can, currency } = useAuth(); const [view, setView] = useState<'grid' | 'list'>('grid'); const [filter, setFilter] = useState<{ status?: string; hk?: string; type?: string }>({});
  const { data, isLoading, refetch } = useApi<any>('/rooms', { pageSize: 500, sort: 'number', order: 'asc' }, { refetchInterval: 30000 });
  const [sel, setSel] = useState<any>(null); const [block, setBlock] = useState<any>(null); const [unblock, setUnblock] = useState<any>(null); const [hk, setHk] = useState<any>(null);
  const blockM = useAction((v: any) => post(`/rooms/${block.id}/block`, v), { success: 'Room blocked', invalidate: ['/rooms'], onSuccess: () => refetch() });
  const unblockM = useAction(() => post(`/rooms/${unblock.id}/unblock`, {}), { success: 'Room released', invalidate: ['/rooms'], onSuccess: () => refetch() });
  const hkM = useAction((v: any) => post(`/rooms/${hk.id}/housekeeping-status`, v), { success: 'Housekeeping status updated', invalidate: ['/rooms', '/housekeeping'], onSuccess: () => refetch() });
  const rooms: any[] = useMemo(() => (data?.data ?? []).filter((r: any) => (!filter.status || r.status === filter.status) && (!filter.hk || r.housekeeping_status === filter.hk) && (!filter.type || r.room_type_name === filter.type)), [data, filter]);
  const byFloor = useMemo(() => { const m: Record<string, any[]> = {}; rooms.forEach((r) => { (m[r.floor ?? '—'] ??= []).push(r); }); return Object.entries(m).sort(); }, [rooms]);
  const counts = useMemo(() => { const c: Record<string, number> = {}; (data?.data ?? []).forEach((r: any) => { c[r.status] = (c[r.status] ?? 0) + 1; }); return c; }, [data]);
  const types = Array.from(new Set((data?.data ?? []).map((r: any) => r.room_type_name))) as string[];
  if (isLoading) return <Spinner />;
  return <div className="space-y-4">
    <PageHeader title="Room rack" subtitle="Live status of every room. Dot = housekeeping status." actions={<div className="flex gap-1"><Button size="icon" variant={view === 'grid' ? 'default' : 'outline'} onClick={() => setView('grid')}><LayoutGrid className="h-4 w-4" /></Button><Button size="icon" variant={view === 'list' ? 'default' : 'outline'} onClick={() => setView('list')}><List className="h-4 w-4" /></Button></div>} />
    <div className="flex flex-wrap items-center gap-2 text-xs">{Object.entries(counts).map(([s, n]) => <button key={s} type="button" onClick={() => setFilter((f) => ({ ...f, status: f.status === s ? undefined : s }))} className={cn('rounded-full border px-2.5 py-1', STATUS_COLORS[s], filter.status === s && 'ring-2 ring-primary')}>{titleCase(s)} <b>{n}</b></button>)}
      <NativeSelect className="h-8 w-40 text-xs" value={filter.hk ?? ''} onChange={(e) => setFilter((f) => ({ ...f, hk: e.target.value || undefined }))}><option value="">All housekeeping</option>{['DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED', 'OUT_OF_ORDER'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</NativeSelect>
      <NativeSelect className="h-8 w-40 text-xs" value={filter.type ?? ''} onChange={(e) => setFilter((f) => ({ ...f, type: e.target.value || undefined }))}><option value="">All room types</option>{types.map((t) => <option key={t}>{t}</option>)}</NativeSelect></div>
    {view === 'grid' ? byFloor.map(([floor, rs]) => <div key={floor}><div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Floor {floor}</div><div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8 gap-2">{rs.map((r) => <button type="button" key={r.id} onClick={() => setSel(r)} className={cn('rounded-lg border-2 p-2 text-left transition hover:shadow', STATUS_COLORS[r.status] ?? 'border-border')}><div className="flex items-center justify-between"><span className="text-lg font-bold">{r.number}</span><span className={cn('h-2.5 w-2.5 rounded-full', HK_DOT[r.housekeeping_status])} title={r.housekeeping_status} /></div><div className="truncate text-[11px] text-muted-foreground">{r.room_type_code ?? r.room_type_name}</div>{r.guest_name && <div className="truncate text-[11px] font-medium">{r.guest_name}{r.vip_level > 0 ? ' ★' : ''}</div>}{r.guest_name && r.expected_check_out && <div className="text-[10px] text-muted-foreground">out {fmtDate(r.expected_check_out)}</div>}{!r.guest_name && r.next_reservation && <div className="truncate text-[10px] text-violet-700 dark:text-violet-300">arr {fmtDate(r.next_reservation.arrival_date ?? r.next_reservation)}</div>}{Number(r.open_maintenance) > 0 && <Badge tone="destructive" className="mt-1">maint.</Badge>}</button>)}</div></div>)
      : <div className="rounded-lg border bg-card overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50 text-[11px] uppercase text-muted-foreground"><tr><th className="px-3 py-2 text-left">Room</th><th className="px-3 py-2 text-left">Type</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Housekeeping</th><th className="px-3 py-2 text-left">Guest</th><th className="px-3 py-2 text-left">Departs</th><th className="px-3 py-2 text-right">Rate</th></tr></thead><tbody className="divide-y">{rooms.map((r) => <tr key={r.id} className="hover:bg-accent/40 cursor-pointer" onClick={() => setSel(r)}><td className="px-3 py-2 font-semibold">{r.number}</td><td className="px-3 py-2">{r.room_type_name}</td><td className="px-3 py-2"><StatusBadge status={r.status} /></td><td className="px-3 py-2"><StatusBadge status={r.housekeeping_status} /></td><td className="px-3 py-2">{r.guest_name ?? ''}</td><td className="px-3 py-2">{r.expected_check_out ? fmtDate(r.expected_check_out) : ''}</td><td className="px-3 py-2 text-right tabular">{fmtMoney(r.rate_override ?? r.base_rate, currency)}</td></tr>)}</tbody></table></div>}
    <Modal open={!!sel} onOpenChange={(o) => !o && setSel(null)} title={sel ? `Room ${sel.number} · ${sel.room_type_name}` : ''} size="md">{sel && <div className="space-y-3">
      <KV items={[['Status', <StatusBadge key="s" status={sel.status} />], ['Housekeeping', <StatusBadge key="h" status={sel.housekeeping_status} />], ['Maintenance', titleCase(sel.maintenance_status)], ['Floor / building', [sel.floor, sel.building].filter(Boolean).join(' / ') || '—'], ['Rate', fmtMoney(sel.rate_override ?? sel.base_rate, currency)], ['Max occupancy', sel.max_occupancy], ['Guest', sel.guest_name ? <Link key="g" href={`/front-office/stays/${sel.stay_id}`} className="text-primary hover:underline">{sel.guest_name}</Link> : '—'], ['Open maintenance', sel.open_maintenance ?? 0]]} />
      {sel.amenities?.length > 0 && <div className="flex flex-wrap gap-1">{sel.amenities.map((a: string) => <Badge key={a} tone="muted">{a}</Badge>)}</div>}
      <div className="flex flex-wrap gap-2 justify-end">
        {can('housekeeping.update') && <Button variant="outline" size="sm" onClick={() => { setHk(sel); setSel(null); }}>Update housekeeping</Button>}
        {can('maintenance.create') && <Button variant="outline" size="sm" onClick={() => (window.location.href = `/maintenance?new=1&room_id=${sel.id}`)}>Report issue</Button>}
        {can('rooms.block') && (['OUT_OF_ORDER', 'OUT_OF_SERVICE', 'BLOCKED'].includes(sel.status) ? <Button variant="outline" size="sm" onClick={() => { setUnblock(sel); setSel(null); }}><Unlock />Release block</Button> : <Button variant="outline" size="sm" onClick={() => { setBlock(sel); setSel(null); }}><Ban />Block room</Button>)}
        {sel.status === 'AVAILABLE' && can('reservations.create') && <Button size="sm" onClick={() => (window.location.href = `/front-office/reservations?new=1&room_type_id=${sel.room_type_id}`)}>Reserve</Button>}
      </div></div>}</Modal>
    <FormDialog open={!!block} onOpenChange={(o) => !o && setBlock(null)} title={`Block room ${block?.number}`} size="sm" cols={1} initial={{ block_type: 'OUT_OF_ORDER', start_date: today(), end_date: addDays(today(), 1) }} fields={[{ name: 'block_type', label: 'Block type', type: 'select', options: ['OUT_OF_ORDER', 'OUT_OF_SERVICE', 'BLOCKED'], required: true }, { name: 'start_date', label: 'From', type: 'date', required: true }, { name: 'end_date', label: 'To', type: 'date', required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }]} onSubmit={(v) => blockM.mutateAsync(v)} />
    <ConfirmDialog open={!!unblock} onOpenChange={(o) => !o && setUnblock(null)} title={`Release block on room ${unblock?.number}?`} confirmLabel="Release" onConfirm={() => unblockM.mutateAsync(undefined as any)} />
    <FormDialog open={!!hk} onOpenChange={(o) => !o && setHk(null)} title={`Housekeeping · room ${hk?.number}`} size="sm" cols={1} initial={{ status: hk?.housekeeping_status }} fields={[{ name: 'status', label: 'Status', type: 'select', options: ['DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED', 'OUT_OF_ORDER'], required: true }, { name: 'notes', label: 'Notes', type: 'textarea' }]} onSubmit={(v) => hkM.mutateAsync(v)} />
  </div>;
}
