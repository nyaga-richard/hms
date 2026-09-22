'use client';
import React from 'react';
import Link from 'next/link';
import { BedDouble, LogIn, LogOut, Users, Percent, Banknote, UtensilsCrossed, Wrench, Sparkles, Boxes, ClipboardCheck, TrendingUp, AlertTriangle, PartyPopper } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, BarChart, Bar, CartesianGrid } from 'recharts';
import { useApi } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section } from '@/components/shared/page';
import { Stat, Spinner, Empty } from '@/components/ui/misc';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { fmtMoney, fmtNum, fmtDate, titleCase } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const ROOM_COLORS: Record<string, string> = { AVAILABLE: 'bg-emerald-500', OCCUPIED: 'bg-sky-500', DIRTY: 'bg-amber-500', CLEAN: 'bg-emerald-500', INSPECTED: 'bg-emerald-600', OUT_OF_ORDER: 'bg-red-500', BLOCKED: 'bg-slate-500', RESERVED: 'bg-violet-500', IN_PROGRESS: 'bg-amber-400' };
export default function DashboardPage() {
  const { user, currency } = useAuth();
  const { data, isLoading } = useApi<any>('/dashboard', {}, { refetchInterval: 60000 } as any);
  if (isLoading) return <Spinner />;
  if (!data) return <Empty title="Dashboard unavailable" />;
  const fo = data.front_office, rev = data.revenue_today, pos = data.pos, inv = data.inventory, fin = data.finance, proc = data.procurement;
  const hour = new Date().getHours(); const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return <div className="space-y-4">
    <PageHeader title={`${greet}, ${user?.full_name?.split(' ')[0]}`} subtitle={<>Business date <strong>{fmtDate(data.business_date)}</strong> · widgets shown match your permissions</>} />
    {fo && <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
      <Stat label="Occupancy" value={`${fo.occupancy_percent}%`} sub={`${fo.in_house} of ${fo.rooms_total - fo.rooms_ooo} rooms`} icon={Percent} tone="info" />
      <Stat label="Arrivals" value={`${fo.arrived}/${fo.arrivals_expected}`} sub="arrived / expected" icon={LogIn} tone="success" />
      <Stat label="Departures" value={`${fo.departed}/${fo.departures_expected}`} sub="departed / expected" icon={LogOut} tone="warning" />
      <Stat label="Guests in house" value={fo.guests_in_house} icon={Users} />
      {rev && <Stat label="ADR" value={fmtMoney(rev.adr, currency)} sub={`RevPAR ${fmtMoney(rev.revpar, currency)}`} icon={TrendingUp} />}
      {rev && <Stat label="Revenue today" value={fmtMoney(rev.total_revenue, currency)} sub={`Rooms ${fmtMoney(rev.room_revenue, currency)}`} icon={Banknote} tone="success" />}
      {fo.no_shows > 0 && <Stat label="No-shows" value={fo.no_shows} tone="destructive" icon={AlertTriangle} />}
    </div>}
    <div className="grid lg:grid-cols-3 gap-4">
      {data.revenue_trend && <Section title="Revenue — last 14 days" className="lg:col-span-2"><div className="h-56">{data.revenue_trend.length ? <ResponsiveContainer><AreaChart data={data.revenue_trend.map((r: any) => ({ ...r, revenue: Number(r.revenue), d: fmtDate(r.date).slice(0, 6) }))}><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} /><stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="d" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmtNum(v / 1000) + 'k'} width={40} /><Tooltip formatter={(v: any) => fmtMoney(v, currency)} contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} /><Area type="monotone" dataKey="revenue" stroke="hsl(var(--primary))" fill="url(#g)" strokeWidth={2} /></AreaChart></ResponsiveContainer> : <Empty title="No revenue posted yet" />}</div></Section>}
      {data.rooms && <Section title="Room status" actions={<Link href="/front-office/rooms" className="text-xs text-primary hover:underline">Open board</Link>}>
        <div className="space-y-3"><div><div className="text-[11px] uppercase text-muted-foreground mb-1">Front office</div><div className="flex flex-wrap gap-1.5">{Object.entries(data.rooms.by_status).map(([k, v]: any) => <span key={k} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"><span className={`h-2 w-2 rounded-full ${ROOM_COLORS[k] ?? 'bg-muted-foreground'}`} />{titleCase(k)} <strong>{v}</strong></span>)}</div></div>
          <div><div className="text-[11px] uppercase text-muted-foreground mb-1">Housekeeping</div><div className="flex flex-wrap gap-1.5">{Object.entries(data.rooms.by_housekeeping).map(([k, v]: any) => <span key={k} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"><span className={`h-2 w-2 rounded-full ${ROOM_COLORS[k] ?? 'bg-muted-foreground'}`} />{titleCase(k)} <strong>{v}</strong></span>)}</div></div>
          {data.housekeeping && <div><div className="text-[11px] uppercase text-muted-foreground mb-1">Today&apos;s tasks</div><div className="flex flex-wrap gap-1.5">{Object.entries(data.housekeeping).length === 0 ? <span className="text-xs text-muted-foreground">No tasks yet</span> : Object.entries(data.housekeeping).map(([k, v]: any) => <StatusBadge key={k} status={`${k} ${v}`} />)}</div></div>}
        </div></Section>}
    </div>
    <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
      {pos && <Section title="Outlets today" actions={<Link href="/pos" className="text-xs text-primary hover:underline">Open POS</Link>}>
        <table className="w-full text-sm"><tbody className="divide-y">{pos.outlets.map((o: any) => <tr key={o.id}><td className="py-1.5"><div className="font-medium">{o.name}</div><div className="text-[11px] text-muted-foreground">{o.closed_orders} closed · {o.open_orders} open · {o.covers} covers</div></td><td className="py-1.5 text-right tabular font-medium">{fmtMoney(o.sales, currency)}</td></tr>)}</tbody></table>
        {pos.top_items?.length > 0 && <div className="mt-3"><div className="text-[11px] uppercase text-muted-foreground mb-1">Top items</div>{pos.top_items.map((t: any) => <div key={t.name} className="flex justify-between text-xs py-0.5"><span>{t.name} × {fmtNum(t.qty)}</span><span className="tabular">{fmtMoney(t.sales, currency)}</span></div>)}</div>}
        {pos.open_shifts > 0 && <div className="mt-2 text-xs text-muted-foreground">{pos.open_shifts} cashier shift(s) open</div>}
      </Section>}
      {data.kitchen && <Section title="Kitchen queue" actions={<Link href="/pos/kitchen" className="text-xs text-primary hover:underline">KDS</Link>}>{data.kitchen.length === 0 ? <Empty title="No tickets in progress" icon={UtensilsCrossed} /> : <div className="grid grid-cols-2 gap-2">{data.kitchen.map((k: any) => <Stat key={k.status} label={titleCase(k.status)} value={k.n} sub={`avg ${k.avg_minutes ?? 0} min`} tone={k.avg_minutes > 20 ? 'destructive' : 'default'} />)}</div>}</Section>}
      {data.maintenance && <Section title="Maintenance" actions={<Link href="/maintenance" className="text-xs text-primary hover:underline">Work orders</Link>}>{data.maintenance.length === 0 ? <Empty title="No open work orders" icon={Wrench} /> : <div className="flex flex-wrap gap-2">{data.maintenance.map((m: any) => <div key={m.status} className="rounded-md border px-3 py-2 text-sm"><StatusBadge status={m.status} /> <strong className="ml-1">{m.n}</strong>{m.urgent > 0 && <span className="ml-2 text-xs text-destructive">{m.urgent} urgent</span>}</div>)}</div>}</Section>}
      {inv && <Section title="Inventory" actions={<Link href="/inventory" className="text-xs text-primary hover:underline">Stock levels</Link>}>
        <div className="grid grid-cols-2 gap-2 mb-3"><Stat label="Stock value" value={fmtMoney(inv.stock_value, currency)} icon={Boxes} /><Stat label="Expiring batches" value={inv.expiring_batches} tone={inv.expiring_batches > 0 ? 'warning' : 'default'} /></div>
        {inv.low_stock.length > 0 ? <><div className="text-[11px] uppercase text-muted-foreground mb-1">Below reorder level</div>{inv.low_stock.map((l: any, i: number) => <div key={i} className="flex justify-between text-xs py-0.5"><span>{l.name} <span className="text-muted-foreground">({l.store})</span></span><span className="tabular text-destructive">{fmtNum(l.quantity, 2)} / {fmtNum(l.reorder_level, 2)}</span></div>)}</> : <div className="text-xs text-muted-foreground">All items above reorder level</div>}
      </Section>}
      {(fin || proc) && <Section title="Finance snapshot" actions={<Link href="/finance" className="text-xs text-primary hover:underline">Finance</Link>}><div className="grid grid-cols-2 gap-2">
        {fin && <><Stat label="Receipts today" value={fmtMoney(fin.receipts_today, currency)} tone="success" /><Stat label="Payments today" value={fmtMoney(fin.payments_today, currency)} tone="warning" /><Stat label="Guest ledger" value={fmtMoney(fin.guest_ledger, currency)} /><Stat label="City ledger (AR)" value={fmtMoney(fin.ar_balance, currency)} /></>}
        {proc && <><Stat label="AP outstanding" value={fmtMoney(proc.ap_outstanding, currency)} sub={Number(proc.ap_overdue) > 0 ? `${fmtMoney(proc.ap_overdue, currency)} overdue` : 'nothing overdue'} tone={Number(proc.ap_overdue) > 0 ? 'destructive' : 'default'} /><Stat label="PRs awaiting approval" value={proc.requisitions_pending} sub={`${proc.po_awaiting_delivery} PO awaiting delivery`} /></>}
        {fin && fin.expenses_pending > 0 && <Stat label="Expenses pending" value={fin.expenses_pending} tone="warning" />}
      </div></Section>}
      {data.approvals && <Section title={`Approvals waiting for you (${data.approvals.pending})`} actions={<Link href="/approvals" className="text-xs text-primary hover:underline">Inbox</Link>}>{data.approvals.items.length === 0 ? <Empty title="Nothing to approve" icon={ClipboardCheck} /> : <div className="divide-y text-sm">{data.approvals.items.map((a: any) => <Link key={a.id} href="/approvals" className="flex items-center justify-between py-1.5 hover:text-primary"><span className="truncate">{a.title ?? `${titleCase(a.transaction_type)} ${a.entity_number ?? ''}`}</span><span className="tabular text-xs text-muted-foreground">{a.amount ? fmtMoney(a.amount, currency) : ''}</span></Link>)}</div>}</Section>}
      {data.events && <Section title="Upcoming events" actions={<Link href="/events" className="text-xs text-primary hover:underline">Events</Link>}>{data.events.length === 0 ? <Empty title="No confirmed events this week" icon={PartyPopper} /> : <div className="divide-y text-sm">{data.events.map((e: any) => <Link key={e.id} href={`/events/${e.id}`} className="flex items-center justify-between py-1.5 gap-2"><div className="min-w-0"><div className="font-medium truncate">{e.name}</div><div className="text-xs text-muted-foreground">{fmtDate(e.start_at)} · {e.venue ?? 'No venue'} · {e.expected_guests} pax</div></div><StatusBadge status={e.status} /></Link>)}</div>}</Section>}
      {data.occupancy_trend && <Section title="Occupancy — last 14 days"><div className="h-44"><ResponsiveContainer><BarChart data={data.occupancy_trend.map((r: any) => ({ ...r, d: fmtDate(r.date).slice(0, 6) }))}><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="d" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} unit="%" width={36} domain={[0, 100]} /><Tooltip formatter={(v: any) => `${v}%`} contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} /><Bar dataKey="occupancy_percent" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div></Section>}
    </div>
    {data.widgets?.length <= 2 && <Empty title="Your dashboard is quiet" hint="Widgets appear based on the permissions your roles grant. Use the navigation to reach your work areas." icon={Sparkles} action={<Link href="/approvals" className="text-sm text-primary hover:underline">Go to approvals</Link>} />}
  </div>;
}
