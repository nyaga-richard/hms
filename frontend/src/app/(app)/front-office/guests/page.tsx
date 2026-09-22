'use client';
import React from 'react';
import { ResourcePage } from '@/components/shared/resource-page';
import { Badge } from '@/components/ui/badge';
import { GUEST_FIELDS } from '@/components/pms/guest-picker';
export default function GuestsPage() {
  return <ResourcePage title="Guests" subtitle="Guest profiles, preferences, stay history and balances." path="/guests" rowHref={(r) => `/front-office/guests/${r.id}`} permissions={{ create: 'guests.create', edit: 'guests.edit' }} searchPlaceholder="Search name, phone, email, ID or guest no…"
    filters={[{ key: 'type', label: 'Type', type: 'select', options: ['INDIVIDUAL', 'CORPORATE', 'TRAVEL_AGENT', 'GROUP', 'GOVERNMENT'] }, { key: 'vip', label: 'VIP level', type: 'select', options: ['1', '2', '3', '4', '5'] }]}
    columns={[{ key: 'guest_no', label: 'No.' }, { key: 'full_name', label: 'Name', render: (r) => <span className="font-medium">{r.title ? `${r.title} ` : ''}{r.full_name} {r.vip_level > 0 && <Badge tone="warning">VIP {r.vip_level}</Badge>} {r.is_blacklisted && <Badge tone="destructive">Blacklisted</Badge>}</span> }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'nationality', label: 'Nationality' }, { key: 'customer_name', label: 'Company', render: (r) => r.customer_name ?? r.company_name ?? '' }, { key: 'stay_count', label: 'Stays', type: 'number' }, { key: 'last_stay', label: 'Last stay', type: 'date' }, { key: 'open_balance', label: 'Open balance', type: 'money' }]}
    fields={[{ name: 'type', label: 'Type', type: 'select', options: ['INDIVIDUAL', 'CORPORATE', 'TRAVEL_AGENT', 'GROUP', 'GOVERNMENT'], default: 'INDIVIDUAL' }, ...GUEST_FIELDS, { name: 'loyalty_number', label: 'Loyalty number' }, { name: 'is_blacklisted', label: 'Blacklisted', type: 'switch' }, { name: 'notes', label: 'Internal notes', type: 'textarea', col: 2 }]} />;
}
