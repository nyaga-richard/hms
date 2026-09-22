'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Pencil, CalendarPlus, Merge } from 'lucide-react';
import { put, post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { FormDialog } from '@/components/shared/form';
import { fmtDate, fmtDateTime, fmtMoney, titleCase } from '@/lib/utils';
import { GUEST_FIELDS } from '@/components/pms/guest-picker';
import { Attachments } from '@/components/shared/attachments';
import { AuditTrail } from '@/components/shared/audit-trail';

export default function GuestDetail() {
  const { id } = useParams<{ id: string }>(); const router = useRouter(); const { can, currency } = useAuth();
  const { data: g, isLoading, refetch } = useApi<any>(`/guests/${id}`); const { data: h } = useApi<any>(`/guests/${id}/history`);
  const [edit, setEdit] = useState(false); const [merge, setMerge] = useState(false);
  const editM = useAction((v: any) => put(`/guests/${id}`, v), { success: 'Guest updated', invalidate: ['/guests'], onSuccess: () => refetch() });
  const mergeM = useAction((v: any) => post(`/guests/${id}/merge`, v), { success: 'Profiles merged', invalidate: ['/guests'], onSuccess: () => refetch() });
  if (isLoading || !g) return <Spinner />;
  return <div className="space-y-4">
    <PageHeader crumbs={[{ label: 'Front office', href: '/front-office' }, { label: 'Guests', href: '/front-office/guests' }, { label: g.full_name }]} title={<span className="flex items-center gap-2">{g.title} {g.full_name} {g.vip_level > 0 && <Badge tone="warning">VIP {g.vip_level}</Badge>}{g.is_blacklisted && <Badge tone="destructive">Blacklisted</Badge>}</span>} subtitle={`${g.guest_no} · ${titleCase(g.type)}${g.customer_name ? ` · ${g.customer_name}` : ''}`}
      actions={<>{can('guests.merge') && <Button variant="outline" onClick={() => setMerge(true)}><Merge />Merge</Button>}{can('guests.edit') && <Button variant="outline" onClick={() => setEdit(true)}><Pencil />Edit</Button>}{can('reservations.create') && <Button onClick={() => router.push('/front-office/reservations?new=1')}><CalendarPlus />New reservation</Button>}</>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <Section title="Profile"><KV items={[['Phone', g.phone ?? '—'], ['Email', g.email ?? '—'], ['Gender', g.gender ?? '—'], ['Date of birth', g.date_of_birth ? fmtDate(g.date_of_birth) : '—'], ['Nationality', g.nationality ?? '—'], ['ID', [g.id_type, g.id_number].filter(Boolean).join(' ') || '—'], ['Address', [g.address, g.city, g.country].filter(Boolean).join(', ') || '—'], ['Loyalty', g.loyalty_number ? `${g.loyalty_number} · ${g.loyalty_points ?? 0} pts` : '—'], ['Stays', g.stay_count], ['Open balance', fmtMoney(g.open_balance, currency)]]} />{g.notes && <p className="mt-2 text-sm text-muted-foreground">{g.notes}</p>}{g.preferences && Object.keys(g.preferences).length > 0 && <div className="mt-2 text-sm"><div className="text-xs uppercase text-muted-foreground">Preferences</div>{Object.entries(g.preferences).map(([k, v]) => <div key={k}>{k}: {String(v)}</div>)}</div>}</Section>
      <div className="lg:col-span-2"><Tabs defaultValue="stays"><TabsList><TabsTrigger value="stays">Stays ({h?.stays?.length ?? 0})</TabsTrigger><TabsTrigger value="reservations">Reservations ({h?.reservations?.length ?? 0})</TabsTrigger><TabsTrigger value="payments">Payments</TabsTrigger><TabsTrigger value="invoices">Invoices</TabsTrigger></TabsList>
        <TabsContent value="stays"><div className="rounded-lg border bg-card divide-y text-sm">{(h?.stays ?? []).map((s: any) => <Link key={s.id} href={`/front-office/stays/${s.id}`} className="flex items-center justify-between p-2 hover:bg-accent"><span>Room {s.room_number} · {s.room_type_name} · {fmtDate(s.check_in_at)} → {fmtDate(s.check_out_at ?? s.expected_check_out)} <StatusBadge status={s.status} /></span><span className="tabular">{fmtMoney(s.total_spend, currency)}</span></Link>)}{!h?.stays?.length && <p className="p-3 text-muted-foreground">No stays yet.</p>}</div></TabsContent>
        <TabsContent value="reservations"><div className="rounded-lg border bg-card divide-y text-sm">{(h?.reservations ?? []).map((r: any) => <Link key={r.id} href={`/front-office/reservations/${r.id}`} className="flex items-center justify-between p-2 hover:bg-accent"><span>{r.number} · {r.room_type_name}{r.room_number ? ` · ${r.room_number}` : ''} · {fmtDate(r.arrival_date)} → {fmtDate(r.departure_date)}</span><StatusBadge status={r.status} /></Link>)}{!h?.reservations?.length && <p className="p-3 text-muted-foreground">No reservations.</p>}</div></TabsContent>
        <TabsContent value="payments"><div className="rounded-lg border bg-card divide-y text-sm">{(h?.payments ?? []).map((p: any) => <div key={p.id} className="flex items-center justify-between p-2"><span>{fmtDateTime(p.created_at)} · {p.method_name} · {p.kind} {p.reference ? `· ${p.reference}` : ''}</span><span className="tabular">{fmtMoney(p.amount, currency)}</span></div>)}{!h?.payments?.length && <p className="p-3 text-muted-foreground">No payments.</p>}</div></TabsContent>
        <TabsContent value="invoices"><div className="rounded-lg border bg-card divide-y text-sm">{(h?.invoices ?? []).map((i: any) => <div key={i.id} className="flex items-center justify-between p-2"><span>{i.number} · {fmtDate(i.invoice_date)} <StatusBadge status={i.status} /></span><span className="tabular">{fmtMoney(i.total, currency)} {Number(i.balance) > 0 && <span className="text-destructive">(due {fmtMoney(i.balance, currency)})</span>}</span></div>)}{!h?.invoices?.length && <p className="p-3 text-muted-foreground">No invoices.</p>}</div></TabsContent>
      </Tabs></div>
    </div>
    <div className="grid gap-4 lg:grid-cols-2"><Attachments entity="guest" entityId={id} title="Documents (ID / passport scans)" /><AuditTrail entity="guest" entityId={id} /></div>
    <FormDialog open={edit} onOpenChange={setEdit} title="Edit guest" size="lg" initial={g} fields={[{ name: 'type', label: 'Type', type: 'select', options: ['INDIVIDUAL', 'CORPORATE', 'TRAVEL_AGENT', 'GROUP', 'GOVERNMENT'] }, ...GUEST_FIELDS, { name: 'loyalty_number', label: 'Loyalty number' }, { name: 'is_blacklisted', label: 'Blacklisted', type: 'switch' }, { name: 'notes', label: 'Internal notes', type: 'textarea', col: 2 }]} onSubmit={(v) => editM.mutateAsync(v)} />
    <FormDialog open={merge} onOpenChange={setMerge} title="Merge duplicate profile into this guest" cols={1} size="sm" fields={[{ name: 'duplicate_id', label: 'Duplicate profile (will be merged & removed)', type: 'lookup', source: '/guests', sourceLabel: (r: any) => `${r.full_name} · ${r.phone ?? ''} · ${r.guest_no}`, required: true }]} onSubmit={(v) => mergeM.mutateAsync(v)} />
  </div>;
}
