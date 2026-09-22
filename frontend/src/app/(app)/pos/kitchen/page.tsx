'use client';
import React, { useEffect, useState } from 'react';
import { ChefHat, Check, Flame, Bell } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner, Empty } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/input';
import { PrintButton, KitchenTicketsDoc } from '@/lib/print';
import { cn, titleCase } from '@/lib/utils';

const NEXT: Record<string, { label: string; to: string; icon: any }> = { NEW: { label: 'Accept', to: 'ACCEPTED', icon: Check }, ACCEPTED: { label: 'Start cooking', to: 'PREPARING', icon: Flame }, PREPARING: { label: 'Ready', to: 'READY', icon: Bell }, READY: { label: 'Served', to: 'SERVED', icon: Check } };
/** Kitchen Display System: live tickets by kitchen/bar station, colour-coded by age, one-tap status progression. */
export default function KitchenPage() {
  const { can } = useAuth(); const [kitchenId, setKitchenId] = useState(''); const [tick, setTick] = useState(0);
  const { data: kitchens } = useApi<any>('/kitchens', { pageSize: 50 });
  const { data, isLoading, refetch } = useApi<any>('/kitchen/tickets', { kitchen_id: kitchenId || undefined }, { refetchInterval: 8000 });
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 15000); return () => clearInterval(t); }, []);
  const m = useAction(({ id, status }: any) => post(`/kitchen/tickets/${id}/status`, { status }), { silent: true, invalidate: ['/kitchen', '/orders'], onSuccess: () => refetch() });
  const tickets: any[] = data?.data ?? [];
  const cols = ['NEW', 'ACCEPTED', 'PREPARING', 'READY'];
  return <div className="space-y-4">
    <PageHeader title="Kitchen display" subtitle="Tickets appear when waiters send orders. Colours: green < 10 min, amber < 20 min, red overdue." actions={<NativeSelect className="h-9 w-56" value={kitchenId} onChange={(e) => setKitchenId(e.target.value)}><option value="">All stations</option>{(kitchens?.data ?? []).map((k: any) => <option key={k.id} value={k.id}>{k.name}</option>)}</NativeSelect>} />
    {isLoading ? <Spinner /> : tickets.length === 0 ? <Empty icon={ChefHat} title="No active tickets" hint="New orders will appear here automatically." /> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{cols.map((col) => <div key={col} className="space-y-2"><div className="flex items-center justify-between text-xs font-semibold uppercase text-muted-foreground"><span>{titleCase(col)}</span><Badge tone="muted">{tickets.filter((t) => t.status === col).length}</Badge></div>
      {tickets.filter((t) => t.status === col).map((t) => { const age = (t.age_seconds ?? 0) + tick * 0; const mins = Math.floor(age / 60); const tone = mins < 10 ? 'border-emerald-400' : mins < 20 ? 'border-amber-400' : 'border-red-500 animate-pulse'; const nx = NEXT[t.status]; return <div key={t.id} className={cn('rounded-lg border-2 bg-card p-3 shadow-sm', tone)}>
        <div className="flex items-start justify-between"><div><div className="font-bold">{t.table_number ? `Table ${t.table_number}` : t.room_number ? `Room ${t.room_number}` : titleCase(t.order_type)}</div><div className="text-[11px] text-muted-foreground">{t.order_number} · {t.outlet_name} · {t.waiter_name ?? ''}{!kitchenId && ` · ${t.kitchen_name}`}</div></div><div className={cn('text-sm font-semibold tabular', mins >= 20 ? 'text-red-600' : mins >= 10 ? 'text-amber-600' : 'text-emerald-600')}>{mins}m</div></div>
        <ul className="mt-2 space-y-1 text-sm">{(t.items ?? []).map((i: any) => <li key={i.id} className={cn(i.voided && 'line-through text-muted-foreground')}><b>{i.quantity}×</b> {i.name}{(i.modifiers ?? []).length > 0 && <span className="text-muted-foreground"> ({i.modifiers.map((m: any) => m.name).join(', ')})</span>}{i.special_instructions && <div className="text-xs italic text-amber-700">“{i.special_instructions}”</div>}{i.course ? <Badge tone="muted" className="ml-1">course {i.course}</Badge> : null}</li>)}</ul>
        <div className="mt-3 flex gap-2">{nx && can('kitchen.update') && <Button size="sm" className="flex-1" onClick={() => m.mutate({ id: t.id, status: nx.to })}><nx.icon />{nx.label}</Button>}<PrintButton doc="kitchen" size="sm" label="Ticket" title={`Ticket #${t.ticket_no} · ${t.order_number}`} render={(ctx) => <KitchenTicketsDoc tickets={[{ ticket: t, items: (t.items ?? []).filter((i: any) => !i.voided) }]} order={{ number: t.order_number, type: t.order_type, table_number: t.table_number, room_number: t.room_number, waiter_name: t.waiter_name, notes: t.notes }} ctx={ctx} />} /></div>
      </div>; })}</div>)}</div>}
  </div>;
}
