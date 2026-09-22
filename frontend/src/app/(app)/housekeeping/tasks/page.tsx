'use client';
import React from 'react';
import { PageHeader } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/ui/badge';
import { titleCase } from '@/lib/utils';
export default function HousekeepingTasksPage() {
  return <div className="space-y-4"><PageHeader title="Housekeeping task log" subtitle="All tasks including completed and inspected — exportable for productivity reviews." />
    <DataTable path="/housekeeping/tasks" defaultSort="created_at" filters={[{ key: 'status', label: 'Status', type: 'select', options: ['PENDING', 'IN_PROGRESS', 'DONE', 'INSPECTED', 'FAILED_INSPECTION', 'CANCELLED'] }, { key: 'task_type', label: 'Type', type: 'select', options: ['CHECKOUT_CLEAN', 'STAYOVER', 'TURNDOWN', 'DEEP_CLEAN', 'INSPECTION', 'TOUCH_UP', 'LINEN_CHANGE', 'MINIBAR_CHECK'] }, { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' }]}
      columns={[{ key: 'business_date', label: 'Date', type: 'date' }, { key: 'room_number', label: 'Room' }, { key: 'task_type', label: 'Type', render: (r) => titleCase(r.task_type) }, { key: 'priority', label: 'Prio', type: 'number', decimals: 0 }, { key: 'assignee', label: 'Attendant' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { key: 'started_at', label: 'Started', type: 'datetime' }, { key: 'completed_at', label: 'Completed', type: 'datetime' }, { key: 'minutes_taken', label: 'Min', type: 'number', decimals: 0 }, { key: 'inspection_score', label: 'Score', type: 'number', decimals: 0 }]} />
  </div>;
}
