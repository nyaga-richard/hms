'use client';
import React from 'react';
import { ResourcePage } from '@/components/shared/resource-page';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/page';
import { StatusBadge } from '@/components/ui/badge';

const STATUSES = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'];
export default function HrPage() {
  return <div className="space-y-4">
    <PageHeader title="HR & staff" subtitle="Employee master data, shift templates and department structure. Payroll stays in your payroll system — link via external payroll reference." />
    <Tabs defaultValue="employees"><TabsList><TabsTrigger value="employees">Employees</TabsTrigger><TabsTrigger value="templates">Shift templates</TabsTrigger><TabsTrigger value="departments">Departments</TabsTrigger></TabsList>
      <TabsContent value="employees"><ResourcePage embedded title="Employees" path="/employees" searchPlaceholder="Search name, number, position, phone…" permissions={{ create: 'employees.manage', edit: 'employees.manage' }} filters={[{ key: 'status', label: 'Status', type: 'select', options: STATUSES }, { key: 'department_id', label: 'Department', type: 'select', source: '/departments' }]}
        columns={[{ key: 'employee_no', label: 'No.' }, { key: 'full_name', label: 'Name' }, { key: 'position', label: 'Position' }, { key: 'department_name', label: 'Department' }, { key: 'phone', label: 'Phone' }, { key: 'username', label: 'System user' }, { key: 'hire_date', label: 'Hired', type: 'date' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]}
        fields={[{ name: 'employee_no', label: 'Employee no.', required: true }, { name: 'department_id', label: 'Department', type: 'lookup', source: '/departments' }, { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name', required: true }, { name: 'position', label: 'Position' }, { name: 'hire_date', label: 'Hire date', type: 'date' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'national_id', label: 'National ID' }, { name: 'external_payroll_ref', label: 'Payroll reference' }, { name: 'status', label: 'Status', type: 'select', options: STATUSES, default: 'ACTIVE' }, { name: 'notes', label: 'Notes', type: 'textarea', col: 2 }]} /></TabsContent>
      <TabsContent value="templates"><ResourcePage embedded title="Shift templates" subtitle="Reusable shift patterns (e.g. Morning 06:00–14:00) used when building the roster." path="/shift-templates" permissions={{ create: 'employees.manage', edit: 'employees.manage', delete: 'employees.manage' }}
        columns={[{ key: 'name', label: 'Shift' }, { key: 'start_time', label: 'Start', render: (r) => String(r.start_time).slice(0, 5) }, { key: 'end_time', label: 'End', render: (r) => String(r.end_time).slice(0, 5) }, { key: 'department_name', label: 'Department' }, { key: 'is_active', label: 'Active', type: 'bool' }]}
        fields={[{ name: 'name', label: 'Name', required: true }, { name: 'department_id', label: 'Department (optional)', type: 'lookup', source: '/departments' }, { name: 'start_time', label: 'Start time', type: 'time', required: true }, { name: 'end_time', label: 'End time', type: 'time', required: true }, { name: 'is_active', label: 'Active', type: 'switch', default: true }]} /></TabsContent>
      <TabsContent value="departments"><ResourcePage embedded title="Departments" path="/departments" permissions={{ view: 'departments.view', create: 'departments.manage', edit: 'departments.manage' }}
        columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Department' }, { key: 'cost_center', label: 'Cost centre' }, { key: 'is_active', label: 'Active', type: 'bool' }]}
        fields={[{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'cost_center', label: 'Cost centre' }, { name: 'is_active', label: 'Active', type: 'switch', default: true }]} /></TabsContent>
    </Tabs>
  </div>;
}
