'use client';
import React from 'react';
import { ResourcePage } from '@/components/shared/resource-page';

export default function DepartmentsPage() {
  return <ResourcePage path="/departments" title="Department" entity="department" subtitle="Departments double as cost centres: expenses, requisitions, staff and journal analysis all reference them." crumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Departments' }]} permissions={{ view: 'departments.view', create: 'departments.manage', edit: 'departments.manage' }} defaultSort="name" fields={[{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'cost_center', label: 'Cost centre code' }, { name: 'is_active', label: 'Active', type: 'switch', default: true }]} columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'cost_center', label: 'Cost centre' }, { key: 'is_active', label: 'Active', type: 'bool' }]} />;
}
