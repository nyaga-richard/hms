'use client';
import React from 'react';
import { PageHeader } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge, Badge } from '@/components/ui/badge';
export default function FoliosPage() {
  return <div className="space-y-4"><PageHeader title="Folios" subtitle="Guest, company and event folios. Charges and payments are immutable — corrections are posted as reversals." />
    <DataTable path="/folios" searchPlaceholder="Search folio number, guest or room…" defaultSort="created_at" defaultOrder="desc" rowHref={(r) => `/front-office/folios/${r.id}`} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['OPEN', 'CLOSED'] }, { key: 'type', label: 'Type', type: 'select', options: ['GUEST', 'COMPANY', 'EVENT', 'HOUSE'] }]}
      columns={[{ key: 'number', label: 'Folio' }, { key: 'guest_name', label: 'Guest / account', render: (r) => <span>{r.guest_name ?? r.customer_name ?? r.event_name ?? '—'}{r.customer_name && r.guest_name && <span className="text-xs text-muted-foreground"> · {r.customer_name}</span>}</span> }, { key: 'room_number', label: 'Room' }, { key: 'type', label: 'Type', render: (r) => <Badge tone="muted">{r.type}</Badge> }, { key: 'charges', label: 'Charges', type: 'money' }, { key: 'credits', label: 'Payments', type: 'money' }, { key: 'balance', label: 'Balance', type: 'money' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { key: 'created_at', label: 'Opened', type: 'date' }]} />
  </div>;
}
