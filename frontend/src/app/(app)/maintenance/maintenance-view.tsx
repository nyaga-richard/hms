'use client';
import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Wrench, Plus } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Stat } from '@/components/ui/misc';
import { FormDialog } from '@/components/shared/form';
import { fmtMoney, titleCase } from '@/lib/utils';

export const MAINT_CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'HVAC', 'CARPENTRY', 'PAINTING', 'IT', 'APPLIANCE', 'GENERAL', 'PREVENTIVE', 'SAFETY', 'POOL', 'GROUNDS', 'VEHICLE'];
const PRIO_TONE: Record<string, any> = { LOW: 'muted', MEDIUM: 'info', HIGH: 'warning', URGENT: 'destructive' };
export function ReportIssueDialog({ open, onOpenChange, roomId, assetId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; roomId?: string | null; assetId?: string | null; onDone?: (r: any) => void }) {
  const m = useAction((v: any) => post('/maintenance', { ...v, room_id: v.room_id || null, asset_id: v.asset_id || null, estimated_cost: v.estimated_cost ? Number(v.estimated_cost) : 0 }), { success: 'Issue reported — routed for approval/assignment', invalidate: ['/maintenance', '/rooms', '/dashboard'], onSuccess: (r: any) => onDone?.(r) });
  return <FormDialog open={open} onOpenChange={onOpenChange} title="Report maintenance issue" size="lg" initial={{ priority: 'MEDIUM', category: 'GENERAL', location_type: roomId ? 'ROOM' : assetId ? 'ASSET' : 'AREA', room_id: roomId ?? '', asset_id: assetId ?? '' }}
    fields={[{ name: 'title', label: 'Issue', required: true, col: 2, placeholder: 'e.g. AC not cooling in room 203' }, { name: 'category', label: 'Category', type: 'select', options: MAINT_CATEGORIES, required: true }, { name: 'priority', label: 'Priority', type: 'select', options: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], required: true }, { name: 'location_type', label: 'Location type', type: 'select', options: ['ROOM', 'ASSET', 'AREA', 'OUTLET', 'VEHICLE', 'OTHER'] }, { name: 'location', label: 'Location description', placeholder: 'Lobby, Pool deck…' }, { name: 'room_id', label: 'Room', type: 'lookup', source: '/rooms', sourceLabel: 'number', sourceQuery: { pageSize: 500, sort: 'number', order: 'asc' } }, { name: 'asset_id', label: 'Asset', type: 'lookup', source: '/assets', sourceLabel: (a: any) => `${a.asset_number} · ${a.name}` }, { name: 'estimated_cost', label: 'Estimated cost', type: 'money' }, { name: 'blocks_room', label: 'Take room out of order', type: 'switch' }, { name: 'description', label: 'Details', type: 'textarea', col: 2 }]}
    submitLabel="Report issue" onSubmit={(v) => m.mutateAsync(v)} />;
}
function MaintenancePageInner() {
  const { can, currency } = useAuth(); const router = useRouter(); const sp = useSearchParams(); const [open, setOpen] = useState(false);
  const { data: s } = useApi<any>('/maintenance/summary');
  useEffect(() => { if (sp.get('new') === '1') setOpen(true); }, [sp]);
  return <div className="space-y-4">
    <PageHeader title="Maintenance" subtitle="Work orders from report → approval → assignment → completion → verification." actions={can('maintenance.create') && <Button onClick={() => setOpen(true)}><Plus />Report issue</Button>} />
    {s && <div className="grid grid-cols-2 md:grid-cols-6 gap-3"><Stat label="Open" value={s.open} tone="info" icon={Wrench} /><Stat label="Urgent" value={s.urgent} tone="destructive" /><Stat label="Unassigned" value={s.unassigned} tone="warning" /><Stat label="Awaiting verification" value={s.awaiting_verification} /><Stat label="Rooms out of order" value={s.rooms_out_of_order} tone="destructive" /><Stat label="Cost this month" value={fmtMoney(s.cost_this_month, currency)} sub={s.avg_hours_to_complete ? `avg ${s.avg_hours_to_complete}h to complete` : undefined} /></div>}
    <DataTable path="/maintenance" defaultSort="created_at" rowHref={(r) => `/maintenance/${r.id}`} searchPlaceholder="Search title, room, location…"
      filters={[{ key: 'status', label: 'Status', type: 'select', options: ['REPORTED', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'VERIFIED', 'REJECTED', 'CANCELLED'] }, { key: 'priority', label: 'Priority', type: 'select', options: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] }, { key: 'category', label: 'Category', type: 'select', options: MAINT_CATEGORIES }]}
      columns={[{ key: 'number', label: 'WO' }, { key: 'title', label: 'Issue', render: (r) => <div><div className="font-medium">{r.title}</div><div className="text-xs text-muted-foreground">{r.room_number ? `Room ${r.room_number}` : r.asset_name ?? r.location ?? titleCase(r.location_type)}</div></div> }, { key: 'category', label: 'Category', render: (r) => titleCase(r.category) }, { key: 'priority', label: 'Priority', render: (r) => <Badge tone={PRIO_TONE[r.priority]}>{r.priority}</Badge> }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { key: 'assigned_to_name', label: 'Assignee', render: (r) => r.assigned_to_name ?? r.contractor_name ?? <span className="text-muted-foreground">—</span> }, { key: 'reported_by_name', label: 'Reported by' }, { key: 'created_at', label: 'Reported', type: 'datetime' }, { key: 'hours_open', label: 'Hours open', type: 'number', decimals: 0 }, { key: 'total_cost', label: 'Cost', type: 'money' }]} />
    <ReportIssueDialog open={open} onOpenChange={setOpen} roomId={sp.get('room_id')} onDone={(r) => router.push(`/maintenance/${r.id}`)} />
  </div>;
}
export function MaintenancePage() { return <Suspense fallback={null}><MaintenancePageInner /></Suspense>; }
