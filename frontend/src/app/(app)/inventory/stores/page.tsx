'use client';
import React from 'react';
import { ResourcePage } from '@/components/shared/resource-page';
import { titleCase } from '@/lib/utils';
export default function StoresPage() {
  return <ResourcePage title="Stores" subtitle="Physical stock locations: main store, kitchen, bars, housekeeping, engineering. Outlets consume from their linked store." path="/stores" permissions={{ view: 'stores.view', create: 'stores.manage', edit: 'stores.manage' }} defaultSort="name"
    filters={[{ key: 'type', label: 'Type', type: 'select', options: ['MAIN', 'FOOD', 'BEVERAGE', 'HOUSEKEEPING', 'ENGINEERING', 'KITCHEN', 'LAUNDRY', 'BAR', 'OUTLET', 'OTHER'] }]}
    columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Store' }, { key: 'type', label: 'Type', render: (r) => titleCase(r.type) }, { key: 'department_name', label: 'Department' }, { key: 'outlet_name', label: 'Outlet' }, { key: 'keeper_name', label: 'Storekeeper' }, { key: 'location', label: 'Location' }, { key: 'sku_count', label: 'SKUs', type: 'number', decimals: 0 }, { key: 'stock_value', label: 'Stock value', type: 'money' }, { key: 'is_active', label: 'Active', type: 'bool' }]}
    fields={[{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'type', label: 'Type', type: 'select', options: ['MAIN', 'FOOD', 'BEVERAGE', 'HOUSEKEEPING', 'ENGINEERING', 'KITCHEN', 'LAUNDRY', 'BAR', 'OUTLET', 'OTHER'], default: 'OTHER' }, { name: 'department_id', label: 'Department', type: 'lookup', source: '/departments' }, { name: 'outlet_id', label: 'Outlet', type: 'lookup', source: '/outlets' }, { name: 'keeper_user_id', label: 'Storekeeper', type: 'lookup', source: '/users', sourceLabel: 'full_name' }, { name: 'location', label: 'Location' }, { name: 'is_active', label: 'Active', type: 'switch', default: true }]} />;
}
