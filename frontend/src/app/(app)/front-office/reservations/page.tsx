'use client';
import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CalendarPlus, CalendarDays } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { fmtMoney, today } from '@/lib/utils';
import { ReservationWizard } from '@/components/pms/reservation-wizard';

const STATUSES = ['INQUIRY', 'TENTATIVE', 'CONFIRMED', 'DEPOSIT_PAID', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'CANCELLED'];
function ReservationsPageInner() {
  const { can, currency } = useAuth(); const router = useRouter(); const sp = useSearchParams();
  const [wizard, setWizard] = useState(false);
  useEffect(() => { if (sp.get('new') === '1') setWizard(true); }, [sp]);
  return <div className="space-y-4">
    <PageHeader title="Reservations" subtitle="All bookings across statuses. Use the calendar for a visual room plan." actions={<><Button variant="outline" onClick={() => router.push('/front-office/calendar')}><CalendarDays />Calendar</Button>{can('reservations.create') && <Button onClick={() => setWizard(true)}><CalendarPlus />New reservation</Button>}</>} />
    <DataTable path="/reservations" searchPlaceholder="Search number, guest, phone, room or company…" defaultSort="arrival_date" defaultOrder="desc" rowHref={(r) => `/front-office/reservations/${r.id}`}
      filters={[{ key: 'status', label: 'Status', type: 'select', options: STATUSES }, { key: 'from', label: 'In-house from', type: 'date' }, { key: 'to', label: 'Arriving by', type: 'date' }, { key: 'source', label: 'Source', type: 'select', options: ['WALK_IN', 'PHONE', 'EMAIL', 'WEBSITE', 'OTA', 'CORPORATE', 'AGENT'] }]}
      columns={[{ key: 'number', label: 'Number', render: (r) => <span className="font-mono text-xs">{r.number}</span> }, { key: 'guest_name', label: 'Guest', render: (r) => <div><div className="font-medium">{r.guest_name} {r.vip_level > 0 && <Badge tone="warning">VIP</Badge>}</div>{r.customer_name && <div className="text-xs text-muted-foreground">{r.customer_name}</div>}</div> }, { key: 'arrival_date', label: 'Arrival', type: 'date' }, { key: 'departure_date', label: 'Departure', type: 'date' }, { key: 'nights', label: 'Nights', type: 'number' }, { key: 'room_type_name', label: 'Room type', render: (r) => <span>{r.room_type_name}{r.room_number && <span className="text-muted-foreground"> · {r.room_number}</span>}</span> }, { key: 'rate', label: 'Rate', type: 'money' }, { key: 'source', label: 'Source' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { key: 'folio_balance', label: 'Balance', type: 'money', render: (r) => <span className={Number(r.folio_balance) > 0 ? 'text-destructive tabular' : 'tabular'}>{fmtMoney(r.folio_balance, currency)}</span> }]} />
    <ReservationWizard open={wizard} onOpenChange={setWizard} defaultArrival={sp.get('arrival') ?? today()} defaultRoomTypeId={sp.get('room_type_id') ?? undefined} onCreated={(r) => router.push(`/front-office/reservations/${r.id}`)} />
  </div>;
}
export default function ReservationsPage() { return <Suspense fallback={null}><ReservationsPageInner /></Suspense>; }
