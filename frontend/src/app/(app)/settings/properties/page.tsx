'use client';
import React, { useState } from 'react';
import { put } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { ResourcePage } from '@/components/shared/resource-page';
import { Button } from '@/components/ui/button';
import { FormDialog } from '@/components/shared/form';
import { titleCase } from '@/lib/utils';

const propertyFields = [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'type', label: 'Type', type: 'select' as const, options: ['HOTEL', 'RESORT', 'LODGE', 'APARTMENTS', 'CAMP', 'RESTAURANT', 'CLUB'], default: 'HOTEL' }, { name: 'currency', label: 'Currency', default: 'KES' }, { name: 'timezone', label: 'Timezone', default: 'Africa/Nairobi' }, { name: 'check_in_time', label: 'Check-in time', type: 'time' as const, default: '14:00' }, { name: 'check_out_time', label: 'Check-out time', type: 'time' as const, default: '11:00' }, { name: 'late_checkout_grace_minutes', label: 'Late check-out grace (min)', type: 'number' as const, default: 60 }, { name: 'service_charge_percent', label: 'Service charge %', type: 'number' as const, default: 0 }, { name: 'tax_number', label: 'Tax / PIN number' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email' }, { name: 'website', label: 'Website' }, { name: 'address', label: 'Address', col: 2 as const }, { name: 'city', label: 'City' }, { name: 'country', label: 'Country' }, { name: 'logo_url', label: 'Logo URL', col: 2 as const }, { name: 'is_active', label: 'Active', type: 'switch' as const, default: true }];
function Company() {
  const { can } = useAuth(); const { data, refetch } = useApi<any>('/companies'); const [edit, setEdit] = useState(false); const c = data?.data?.[0] ?? (Array.isArray(data) ? data[0] : null);
  const save = useAction((v: any) => put(`/companies/${c.id}`, v), { success: 'Company updated', onSuccess: () => { setEdit(false); refetch(); } });
  if (!c) return null;
  return <Section title="Company (legal entity)" actions={can('properties.edit') && <Button size="sm" variant="outline" onClick={() => setEdit(true)}>Edit</Button>}><KV cols={4} items={[['Name', c.name], ['Legal name', c.legal_name ?? '—'], ['Tax number', c.tax_number ?? '—'], ['Base currency', c.base_currency], ['Phone', c.phone ?? '—'], ['Email', c.email ?? '—'], ['Website', c.website ?? '—'], ['Address', c.address ?? '—']]} /><FormDialog open={edit} onOpenChange={setEdit} title="Edit company" fields={[{ name: 'name', label: 'Name', required: true }, { name: 'legal_name', label: 'Legal name' }, { name: 'tax_number', label: 'Tax number' }, { name: 'base_currency', label: 'Base currency', required: true }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email' }, { name: 'website', label: 'Website' }, { name: 'logo_url', label: 'Logo URL' }, { name: 'address', label: 'Address', col: 2 }]} initial={c} onSubmit={(v) => save.mutateAsync(v)} /></Section>;
}
export default function PropertiesPage() {
  return <div className="space-y-4">
    <PageHeader title="Company & properties" subtitle="Multi-property: every transaction, room, outlet and ledger line is scoped to a property; users are granted access per property." crumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Properties' }]} />
    <Company />
    <ResourcePage embedded path="/properties" title="Property" entity="property" permissions={{ view: 'properties.view', create: 'properties.create', edit: 'properties.edit' }} defaultSort="name" fields={propertyFields} dialogSize="lg" columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type', render: (r) => titleCase(r.type) }, { key: 'city', label: 'City' }, { key: 'country', label: 'Country', hideOnMobile: true }, { key: 'currency', label: 'Currency' }, { key: 'timezone', label: 'Timezone', hideOnMobile: true }, { key: 'check_in_time', label: 'In/Out', render: (r) => `${r.check_in_time} / ${r.check_out_time}` }, { key: 'is_active', label: 'Active', type: 'bool' }]} />
  </div>;
}
