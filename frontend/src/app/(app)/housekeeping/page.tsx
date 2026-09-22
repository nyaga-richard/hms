'use client';
import React, { useMemo, useState } from 'react';
import { Sparkles, Play, Check, ClipboardCheck, Wand2, UserCheck } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Spinner, Stat, Empty, Checkbox } from '@/components/ui/misc';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { FormDialog, ConfirmDialog } from '@/components/shared/form';
import { cn, fmtDate, fmtTime, titleCase, today } from '@/lib/utils';

const HK_COLORS: Record<string, string> = { DIRTY: 'border-red-400 bg-red-50 dark:bg-red-950/30', CLEANING: 'border-amber-400 bg-amber-50 dark:bg-amber-950/30', CLEAN: 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30', INSPECTED: 'border-emerald-600 bg-emerald-100 dark:bg-emerald-900/40', OUT_OF_ORDER: 'border-slate-400 bg-slate-100 dark:bg-slate-900/40' };
const TASK_TYPES = ['CHECKOUT_CLEAN', 'STAYOVER', 'TURNDOWN', 'DEEP_CLEAN', 'INSPECTION', 'TOUCH_UP', 'LINEN_CHANGE', 'MINIBAR_CHECK'];
/** Housekeeping board: room status grid + today's task queue with start/complete/inspect and bulk assignment. Mobile-first for attendants. */
export default function HousekeepingPage() {
  const { can, user } = useAuth(); const d = today();
  const { data: rooms, refetch: r1 } = useApi<any>('/housekeeping/rooms', undefined, { refetchInterval: 30000 });
  const { data: tasks, refetch: r2 } = useApi<any>('/housekeeping/tasks', { open: 'true', pageSize: 200, sort: 'priority', order: 'desc' }, { refetchInterval: 30000 });
  const { data: staff } = useApi<any>('/users', { pageSize: 200, active: 'true' }, { enabled: can('housekeeping.assign') });
  const [sel, setSel] = useState<string[]>([]); const [assign, setAssign] = useState(false); const [newTask, setNewTask] = useState(false); const [complete, setComplete] = useState<any>(null); const [inspect, setInspect] = useState<any>(null); const [statusRoom, setStatusRoom] = useState<any>(null); const [mineOnly, setMineOnly] = useState(false);
  const refresh = () => { r1(); r2(); };
  const inv = ['/housekeeping', '/rooms', '/dashboard'];
  const startM = useAction((id: string) => post(`/housekeeping/tasks/${id}/start`, {}), { success: 'Task started', invalidate: inv, onSuccess: refresh });
  const completeM = useAction((v: any) => post(`/housekeeping/tasks/${complete.id}/complete`, { notes: v.notes, minutes_taken: v.minutes_taken ? Number(v.minutes_taken) : undefined, maintenance_issue: v.issue_title ? { title: v.issue_title, description: v.issue_description, priority: v.issue_priority ?? 'MEDIUM' } : null }), { success: 'Room cleaned — awaiting inspection', invalidate: inv, onSuccess: refresh });
  const inspectM = useAction((v: any) => post(`/housekeeping/tasks/${inspect.id}/inspect`, { passed: v.passed !== false, score: v.score ? Number(v.score) : undefined, notes: v.notes }), { success: 'Inspection recorded', invalidate: inv, onSuccess: refresh });
  const assignM = useAction((v: any) => post('/housekeeping/tasks/assign', { task_ids: sel, assigned_to: v.assigned_to }), { success: 'Tasks assigned', invalidate: inv, onSuccess: () => { setSel([]); refresh(); } });
  const genM = useAction((v: any) => post('/housekeeping/tasks/generate', v), { success: 'Tasks generated for occupied rooms', invalidate: inv, onSuccess: refresh });
  const createM = useAction((v: any) => post('/housekeeping/tasks', { ...v, priority: v.priority ? Number(v.priority) : 5 }), { success: 'Task created', invalidate: inv, onSuccess: refresh });
  const statusM = useAction((v: any) => post(`/housekeeping/rooms/${statusRoom.id}/status`, v), { success: 'Room status updated', invalidate: inv, onSuccess: refresh });
  const roomList: any[] = rooms?.data ?? (Array.isArray(rooms) ? rooms : []);
  const taskList: any[] = useMemo(() => (tasks?.data ?? []).filter((t: any) => !mineOnly || t.assigned_to === user?.id), [tasks, mineOnly, user]);
  const counts = useMemo(() => { const c: Record<string, number> = {}; roomList.forEach((r) => { c[r.housekeeping_status] = (c[r.housekeeping_status] ?? 0) + 1; }); return c; }, [roomList]);
  const staffOpts = (staff?.data ?? []).map((u: any) => ({ value: u.id, label: u.full_name }));
  if (!rooms || !tasks) return <Spinner />;
  return <div className="space-y-4">
    <PageHeader title="Housekeeping" subtitle={`Room status and cleaning queue for ${fmtDate(d)}`} actions={<>
      {can('housekeeping.assign') && <Button variant="outline" onClick={() => genM.mutate({ task_type: 'STAYOVER' })} loading={genM.isPending}><Wand2 />Generate stayover tasks</Button>}
      {(can('housekeeping.assign') || can('housekeeping.update')) && <Button onClick={() => setNewTask(true)}><Sparkles />New task</Button>}
    </>} />
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3"><Stat label="Dirty" value={counts.DIRTY ?? 0} tone="destructive" /><Stat label="Cleaning" value={counts.CLEANING ?? 0} tone="warning" /><Stat label="Clean" value={counts.CLEAN ?? 0} tone="success" /><Stat label="Inspected" value={counts.INSPECTED ?? 0} tone="success" /><Stat label="Open tasks" value={taskList.length} tone="info" /></div>
    <Tabs defaultValue="tasks">
      <TabsList><TabsTrigger value="tasks">Task queue</TabsTrigger><TabsTrigger value="rooms">Room status</TabsTrigger></TabsList>
      <TabsContent value="tasks">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm"><label className="flex items-center gap-2"><Checkbox checked={mineOnly} onCheckedChange={(v) => setMineOnly(!!v)} /> My tasks only</label>{sel.length > 0 && can('housekeeping.assign') && <Button size="sm" variant="outline" onClick={() => setAssign(true)}><UserCheck />Assign {sel.length} task(s)</Button>}</div>
        {taskList.length === 0 ? <Empty title="No open housekeeping tasks" hint="Checkouts create tasks automatically; use “Generate stayover tasks” for in-house rooms." /> : <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{taskList.map((t) => <div key={t.id} className={cn('rounded-lg border-2 p-3 flex flex-col gap-2', HK_COLORS[t.housekeeping_status] ?? '')}>
          <div className="flex items-start justify-between gap-2"><div className="flex items-start gap-2">{can('housekeeping.assign') && t.status === 'PENDING' && <Checkbox className="mt-1" checked={sel.includes(t.id)} onCheckedChange={(v) => setSel((s) => (v ? [...s, t.id] : s.filter((x) => x !== t.id)))} />}<div><div className="text-lg font-bold leading-tight">Room {t.room_number} <span className="text-xs font-normal text-muted-foreground">{t.room_type}</span></div><div className="text-xs">{titleCase(t.task_type)} · priority {t.priority}{t.guest_name ? ` · ${t.guest_name}` : ''}</div></div></div><StatusBadge status={t.status} /></div>
          <div className="text-xs text-muted-foreground">{t.assignee ? <>Assigned to <b>{t.assignee}</b></> : <i>Unassigned</i>}{t.started_at && ` · started ${fmtTime(t.started_at)}`}{t.notes && <div className="italic mt-1">{t.notes}</div>}</div>
          <div className="flex flex-wrap justify-end gap-1">{t.status === 'PENDING' && can('housekeeping.update') && <Button size="sm" onClick={() => startM.mutate(t.id)}><Play />Start</Button>}{t.status === 'IN_PROGRESS' && can('housekeeping.update') && <Button size="sm" onClick={() => setComplete(t)}><Check />Done</Button>}{(t.status === 'DONE' || t.status === 'FAILED_INSPECTION') && can('housekeeping.inspect') && <Button size="sm" variant="outline" onClick={() => setInspect(t)}><ClipboardCheck />Inspect</Button>}{t.status === 'FAILED_INSPECTION' && can('housekeeping.update') && <Button size="sm" onClick={() => startM.mutate(t.id)}><Play />Re-clean</Button>}</div>
        </div>)}</div>}
      </TabsContent>
      <TabsContent value="rooms"><div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8 gap-2">{roomList.map((r) => <button type="button" key={r.id} disabled={!can('housekeeping.update')} onClick={() => setStatusRoom(r)} className={cn('rounded-lg border-2 p-2 text-left', HK_COLORS[r.housekeeping_status])}><div className="text-lg font-bold">{r.number}</div><div className="text-[11px]">{titleCase(r.housekeeping_status)}</div><div className="text-[10px] text-muted-foreground truncate">{r.status === 'OCCUPIED' ? (r.due_out ? 'Due out' : 'Stayover') : titleCase(r.status)}{r.arrival_today ? ' · arrival' : ''}</div>{r.guest_name && <div className="text-[10px] truncate">{r.guest_name}</div>}</button>)}</div></TabsContent>
    </Tabs>
    <FormDialog open={assign} onOpenChange={setAssign} title={`Assign ${sel.length} task(s)`} size="sm" cols={1} fields={[{ name: 'assigned_to', label: 'Attendant', type: 'select', options: staffOpts, required: true }]} onSubmit={(v) => assignM.mutateAsync(v)} />
    <FormDialog open={newTask} onOpenChange={setNewTask} title="New housekeeping task" size="sm" fields={[{ name: 'room_id', label: 'Room', type: 'lookup', source: '/rooms', sourceLabel: (r: any) => `${r.number} · ${r.housekeeping_status}`, sourceQuery: { pageSize: 500, sort: 'number', order: 'asc' }, required: true }, { name: 'task_type', label: 'Type', type: 'select', options: TASK_TYPES, required: true, default: 'TOUCH_UP' }, { name: 'priority', label: 'Priority (0-10)', type: 'number', default: 5, min: 0, max: 10 }, { name: 'assigned_to', label: 'Assign to', type: 'select', options: staffOpts }, { name: 'notes', label: 'Notes', type: 'textarea', col: 2 }]} onSubmit={(v) => createM.mutateAsync(v)} />
    <FormDialog open={!!complete} onOpenChange={(o) => !o && setComplete(null)} title={`Complete cleaning · Room ${complete?.room_number}`} size="md" fields={[{ name: 'minutes_taken', label: 'Minutes taken', type: 'number' }, { name: 'notes', label: 'Notes' }, { name: 'issue_title', label: 'Report maintenance issue (optional)', placeholder: 'e.g. Leaking tap', col: 2 }, { name: 'issue_priority', label: 'Issue priority', type: 'select', options: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] }, { name: 'issue_description', label: 'Issue details', type: 'textarea', col: 2 }]} submitLabel="Mark done" onSubmit={(v) => completeM.mutateAsync(v)} />
    <FormDialog open={!!inspect} onOpenChange={(o) => !o && setInspect(null)} title={`Inspect · Room ${inspect?.room_number}`} size="sm" cols={1} initial={{ passed: true }} fields={[{ name: 'passed', label: 'Passed inspection', type: 'switch' }, { name: 'score', label: 'Score (0-100)', type: 'number', min: 0, max: 100 }, { name: 'notes', label: 'Notes', type: 'textarea' }]} submitLabel="Record inspection" onSubmit={(v) => inspectM.mutateAsync(v)} />
    <FormDialog open={!!statusRoom} onOpenChange={(o) => !o && setStatusRoom(null)} title={`Room ${statusRoom?.number} status`} size="sm" cols={1} initial={{ housekeeping_status: statusRoom?.housekeeping_status }} fields={[{ name: 'housekeeping_status', label: 'Housekeeping status', type: 'select', options: ['DIRTY', 'CLEANING', 'CLEAN', 'INSPECTED', 'OUT_OF_ORDER'], required: true }, { name: 'notes', label: 'Notes' }]} onSubmit={(v) => statusM.mutateAsync(v)} />
  </div>;
}
