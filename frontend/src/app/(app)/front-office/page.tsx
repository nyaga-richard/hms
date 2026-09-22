'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogIn, LogOut, UserPlus, BedDouble, Wallet, ArrowRightLeft, CalendarPlus } from 'lucide-react';
import { useApi, useAction } from '@/lib/query';
import { post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Stat, Empty, Spinner } from '@/components/ui/misc';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { fmtDate, fmtMoney, today, fmtTime } from '@/lib/utils';
import { CheckInDialog } from '@/components/pms/checkin-dialog';
import { CheckOutDialog } from '@/components/pms/checkout-dialog';
import { ConfirmDialog } from '@/components/shared/form';

export default function FrontDeskPage() {
  const { can, currency } = useAuth(); const router = useRouter(); const d = today();
  const { data: arr, refetch: r1 } = useApi<any>('/reservations', { arrival: d, pageSize: 100, status: 'CONFIRMED,TENTATIVE,DEPOSIT_PAID,INQUIRY' });
  const { data: dep, refetch: r2 } = useApi<any>('/stays', { status: 'IN_HOUSE', due: d, pageSize: 100 });
  const { data: inh, refetch: r3 } = useApi<any>('/stays', { status: 'IN_HOUSE', pageSize: 200 });
  const { data: dash } = useApi<any>('/dashboard');
  const [checkin, setCheckin] = useState<{ open: boolean; reservation?: any; walkIn?: boolean }>({ open: false });
  const [checkout, setCheckout] = useState<any>(null); const [noShow, setNoShow] = useState<any>(null);
  const refresh = () => { r1(); r2(); r3(); };
  const noShowM = useAction((id: string) => post(`/reservations/${id}/no-show`, {}), { success: 'Marked as no-show', onSuccess: refresh });
  const arrivals: any[] = (arr?.data ?? []).filter((r: any) => r.arrival_date?.slice(0, 10) === d && ['CONFIRMED', 'TENTATIVE', 'DEPOSIT_PAID', 'INQUIRY'].includes(r.status));
  const departures: any[] = (dep?.data ?? []).filter((s: any) => String(s.expected_check_out).slice(0, 10) <= d);
  const inHouse: any[] = inh?.data ?? []; const fo = dash?.front_office;
  return <div className="space-y-4">
    <PageHeader title="Front Desk" subtitle={`Business date ${fmtDate(dash?.business_date ?? d)}`} actions={<>
      {can('reservations.create') && <Button variant="outline" onClick={() => router.push('/front-office/reservations?new=1')}><CalendarPlus />New reservation</Button>}
      {can('checkin.create') && <Button onClick={() => setCheckin({ open: true, walkIn: true })}><UserPlus />Walk-in check-in</Button>}
    </>} />
    {fo && <div className="grid grid-cols-2 md:grid-cols-5 gap-3"><Stat label="Occupancy" value={`${fo.occupancy_percent}%`} tone="info" /><Stat label="Arrivals today" value={`${fo.arrived} / ${fo.arrivals_expected + fo.arrived}`} sub="checked in / expected" tone="success" icon={LogIn} /><Stat label="Departures" value={`${fo.departed} / ${fo.departures_expected + fo.departed}`} sub="out / expected" tone="warning" icon={LogOut} /><Stat label="In house" value={fo.in_house} sub={`${fo.guests_in_house} guests`} icon={BedDouble} /><Stat label="Guest ledger" value={fmtMoney(dash?.finance?.guest_ledger ?? inHouse.reduce((s, x) => s + Number(x.balance ?? 0), 0), currency)} icon={Wallet} /></div>}
    <Tabs defaultValue="arrivals">
      <TabsList><TabsTrigger value="arrivals">Arrivals <Badge tone="muted" className="ml-1">{arrivals.length}</Badge></TabsTrigger><TabsTrigger value="departures">Departures <Badge tone="muted" className="ml-1">{departures.length}</Badge></TabsTrigger><TabsTrigger value="inhouse">In-house <Badge tone="muted" className="ml-1">{inHouse.length}</Badge></TabsTrigger></TabsList>
      <TabsContent value="arrivals">{!arr ? <Spinner /> : arrivals.length === 0 ? <Empty title="No pending arrivals for today" hint="Walk-ins can be checked in directly." /> : <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{arrivals.map((r) => <div key={r.id} className="rounded-lg border bg-card p-3 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2"><div><Link href={`/front-office/reservations/${r.id}`} className="font-medium hover:underline">{r.guest_name}</Link> {r.vip_level > 0 && <Badge tone="warning">VIP</Badge>}<div className="text-xs text-muted-foreground">{r.number} · {r.room_type_name}{r.room_number ? ` · Room ${r.room_number}` : ' · unassigned'} · {r.nights} night{r.nights === 1 ? '' : 's'} · {r.adults}A {r.children}C</div>{r.eta && <div className="text-xs">ETA {r.eta}</div>}{r.special_requests && <div className="text-xs italic text-muted-foreground line-clamp-2">“{r.special_requests}”</div>}</div><StatusBadge status={r.status} /></div>
        <div className="flex items-center justify-between text-xs"><span>{fmtMoney(r.rate, currency)}/night · deposit {fmtMoney(r.deposit_paid, currency)}{Number(r.deposit_required) > 0 && ` / ${fmtMoney(r.deposit_required, currency)}`}</span><div className="flex gap-1">{can('reservations.no_show') && <Button size="sm" variant="ghost" onClick={() => setNoShow(r)}>No-show</Button>}{can('checkin.create') && <Button size="sm" onClick={() => setCheckin({ open: true, reservation: r })}><LogIn />Check in</Button>}</div></div>
      </div>)}</div>}</TabsContent>
      <TabsContent value="departures">{!dep ? <Spinner /> : departures.length === 0 ? <Empty title="No departures due" /> : <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{departures.map((s) => <div key={s.id} className="rounded-lg border bg-card p-3 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2"><div><Link href={`/front-office/stays/${s.id}`} className="font-medium hover:underline">Room {s.room_number} · {s.guest_name}</Link><div className="text-xs text-muted-foreground">{s.room_type_name} · arrived {fmtDate(s.check_in_at)} · due out {fmtDate(s.expected_check_out)}</div></div><span className={`tabular text-sm font-semibold ${Number(s.balance) > 0 ? 'text-destructive' : 'text-emerald-600'}`}>{fmtMoney(s.balance, currency)}</span></div>
        <div className="flex justify-end gap-1"><Button size="sm" variant="outline" onClick={() => router.push(`/front-office/folios/${s.folio_id}`)}><Wallet />Folio</Button>{can('checkout.create') && <Button size="sm" onClick={() => setCheckout(s)}><LogOut />Check out</Button>}</div>
      </div>)}</div>}</TabsContent>
      <TabsContent value="inhouse">{!inh ? <Spinner /> : inHouse.length === 0 ? <Empty title="No guests in house" /> : <div className="rounded-lg border bg-card overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr><th className="px-3 py-2 text-left">Room</th><th className="px-3 py-2 text-left">Guest</th><th className="px-3 py-2 text-left hidden md:table-cell">Arrived</th><th className="px-3 py-2 text-left">Departs</th><th className="px-3 py-2 text-right">Rate</th><th className="px-3 py-2 text-right">Balance</th><th className="px-2" /></tr></thead><tbody className="divide-y">{inHouse.map((s) => <tr key={s.id} className="hover:bg-accent/40"><td className="px-3 py-2 font-semibold">{s.room_number}</td><td className="px-3 py-2"><Link href={`/front-office/stays/${s.id}`} className="hover:underline">{s.guest_name}</Link>{s.customer_name && <div className="text-xs text-muted-foreground">{s.customer_name}</div>}</td><td className="px-3 py-2 hidden md:table-cell">{fmtDate(s.check_in_at)} {fmtTime(s.check_in_at)}</td><td className="px-3 py-2">{fmtDate(s.expected_check_out)}{String(s.expected_check_out).slice(0, 10) < d && <Badge tone="destructive" className="ml-1">overdue</Badge>}</td><td className="px-3 py-2 text-right tabular">{fmtMoney(s.rate, currency)}</td><td className={`px-3 py-2 text-right tabular font-medium ${Number(s.balance) > 0 ? 'text-destructive' : ''}`}>{fmtMoney(s.balance, currency)}</td><td className="px-2 text-right whitespace-nowrap"><Button size="sm" variant="ghost" onClick={() => router.push(`/front-office/folios/${s.folio_id}`)}>Folio</Button>{can('checkout.create') && <Button size="sm" variant="ghost" onClick={() => setCheckout(s)}>Check out</Button>}</td></tr>)}</tbody></table></div>}</TabsContent>
    </Tabs>
    <CheckInDialog open={checkin.open} onOpenChange={(o) => setCheckin((s) => ({ ...s, open: o }))} reservation={checkin.reservation} walkIn={checkin.walkIn} onDone={refresh} />
    <CheckOutDialog stay={checkout} onOpenChange={(o) => !o && setCheckout(null)} onDone={refresh} />
    <ConfirmDialog open={!!noShow} onOpenChange={(o) => !o && setNoShow(null)} title={`Mark ${noShow?.guest_name} as no-show?`} description="Applies the no-show policy (deposit forfeiture is posted automatically when configured)." destructive confirmLabel="Mark no-show" onConfirm={() => noShowM.mutateAsync(noShow.id)} />
  </div>;
}
