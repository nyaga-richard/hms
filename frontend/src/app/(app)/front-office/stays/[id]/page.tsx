'use client';
import React, { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { LogOut, ArrowRightLeft, CalendarPlus, Receipt, Wallet } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { FormDialog } from '@/components/shared/form';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/utils';
import { CheckOutDialog } from '@/components/pms/checkout-dialog';
import { FolioView } from '@/components/pms/folio-view';
import { Attachments } from '@/components/shared/attachments';

export default function StayDetail() {
  const { id } = useParams<{ id: string }>(); const router = useRouter(); const { can, currency } = useAuth();
  const { data: s, isLoading, refetch } = useApi<any>(`/stays/${id}`);
  const [checkout, setCheckout] = useState(false); const [move, setMove] = useState(false); const [extend, setExtend] = useState(false);
  const moveM = useAction((v: any) => post(`/stays/${id}/move-room`, v), { success: 'Room moved', invalidate: ['/stays', '/rooms', '/folios'], onSuccess: () => refetch() });
  const extendM = useAction((v: any) => post(`/stays/${id}/extend`, v), { success: 'Stay extended', invalidate: ['/stays', '/reservations'], onSuccess: () => refetch() });
  const postM = useAction(() => post(`/stays/${id}/post-room-charge`, {}), { success: 'Room charge posted', invalidate: ['/folios'], onSuccess: () => refetch() });
  if (isLoading || !s) return <Spinner />;
  const folio = (s.folios ?? []).find((f: any) => f.type === 'GUEST') ?? s.folios?.[0]; const inHouse = s.status === 'IN_HOUSE';
  return <div className="space-y-4">
    <PageHeader crumbs={[{ label: 'Front office', href: '/front-office' }, { label: `Room ${s.room_number}` }]} title={<span className="flex items-center gap-2">Room {s.room_number} · {s.guest_name} <StatusBadge status={s.status} />{s.vip_level > 0 && <Badge tone="warning">VIP {s.vip_level}</Badge>}</span>} subtitle={`${s.room_type_name} · arrived ${fmtDateTime(s.check_in_at)} · due out ${fmtDate(s.expected_check_out)}`}
      actions={inHouse && <>
        {can('folios.post') && <Button variant="outline" onClick={() => postM.mutate(undefined as any)} loading={postM.isPending}><Receipt />Post room charge</Button>}
        {can('reservations.modify') && <Button variant="outline" onClick={() => setExtend(true)}><CalendarPlus />Extend</Button>}
        {can('reservations.modify') && <Button variant="outline" onClick={() => setMove(true)}><ArrowRightLeft />Move room</Button>}
        {can('checkout.create') && <Button onClick={() => setCheckout(true)}><LogOut />Check out</Button>}
      </>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <Section title="Stay"><KV items={[['Reservation', <a key="r" href={`/front-office/reservations/${s.reservation_id}`} className="text-primary hover:underline">{s.reservation_number}</a>], ['Company', s.customer_name ?? '—'], ['Rate', `${fmtMoney(s.rate, currency)} / night`], ['Meal plan', s.meal_plan ?? '—'], ['Occupancy', `${s.adults}A · ${s.children}C`], ['Last room charge', s.last_room_charge_date ? fmtDate(s.last_room_charge_date) : 'Not yet'], ['ID', [s.id_type, s.id_number].filter(Boolean).join(' ') || '—'], ['Phone', s.guest_phone ?? '—'], ['Nationality', s.nationality ?? '—'], ['Source', s.source ?? '—']]} />
        {s.special_requests && <p className="mt-2 text-sm italic text-muted-foreground">“{s.special_requests}”</p>}
        {s.room_history?.length > 0 && <div className="mt-3"><div className="text-xs uppercase text-muted-foreground mb-1">Room history</div><ul className="text-sm space-y-1">{s.room_history.map((h: any) => <li key={h.id}>{fmtDateTime(h.moved_at ?? h.created_at)}: {h.from_room_number ?? h.from_room} → {h.to_room_number ?? h.to_room} <span className="text-muted-foreground">({h.reason})</span></li>)}</ul></div>}
      </Section>
      <div className="lg:col-span-2 space-y-4">
        {folio ? <FolioView folioId={folio.id} compact /> : <Section title="Folio"><p className="text-sm text-muted-foreground">No folio.</p></Section>}
        {s.folios?.length > 1 && <div className="text-sm">Other folios: {s.folios.filter((f: any) => f.id !== folio?.id).map((f: any) => <a key={f.id} href={`/front-office/folios/${f.id}`} className="text-primary hover:underline mr-2">{f.number} ({f.type})</a>)}</div>}
      </div>
    </div>
    <Attachments entity="stay" entityId={id} />
    <CheckOutDialog stay={checkout ? { ...s, folio_id: folio?.id } : null} onOpenChange={(o) => !o && setCheckout(false)} onDone={() => refetch()} />
    <FormDialog open={move} onOpenChange={setMove} title="Move room" size="sm" cols={1} fields={[{ name: 'to_room_id', label: 'New room', type: 'lookup', source: '/rooms', sourceLabel: (r: any) => `${r.number} · ${r.room_type_name} · ${r.status}/${r.housekeeping_status}`, sourceQuery: { status: 'AVAILABLE', pageSize: 500 }, required: true }, { name: 'new_rate', label: 'New rate (optional)', type: 'money' }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }]} onSubmit={(v) => moveM.mutateAsync(v)} />
    <FormDialog open={extend} onOpenChange={setExtend} title="Extend / shorten stay" size="sm" cols={1} initial={{ new_departure: String(s.expected_check_out).slice(0, 10) }} fields={[{ name: 'new_departure', label: 'New departure date', type: 'date', required: true }, { name: 'reason', label: 'Reason', type: 'text' }]} onSubmit={(v) => extendM.mutateAsync(v)} />
  </div>;
}
