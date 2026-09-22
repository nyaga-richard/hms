'use client';
import React, { useState } from 'react';
import { Shirt, Plus, ArrowRight } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/misc';
import { LookupSelect } from '@/components/shared/form';
import { ResourcePage } from '@/components/shared/resource-page';
import { DataTable } from '@/components/shared/data-table';
import { StatusBadge } from '@/components/ui/badge';
import { fmtMoney, fmtTime, titleCase } from '@/lib/utils';

const FLOW = ['COLLECTED', 'SORTING', 'WASHING', 'DRYING', 'IRONING', 'QUALITY_CHECK', 'READY', 'DELIVERED', 'RETURNED_TO_STORE'];
/** Laundry: kanban board by stage, guest laundry auto-charges the folio; hotel linen & uniforms tracked separately. */
export default function LaundryPage() {
  const { can, currency } = useAuth();
  const { data: board, isLoading, refetch } = useApi<any>('/laundry/board', undefined, { refetchInterval: 30000 });
  const { data: services } = useApi<any>('/laundry-services', { pageSize: 200 });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({ type: 'GUEST', stay_id: '', room_id: '', department_id: '', express: false, notes: '', charge_now: true, items: [{ service_id: '', description: '', quantity: 1 }] });
  const moveM = useAction(({ id, status }: any) => post(`/laundry/${id}/status`, { status }), { success: 'Moved', invalidate: ['/laundry'], onSuccess: () => refetch() });
  const createM = useAction(() => post('/laundry', { ...form, stay_id: form.stay_id || null, room_id: form.room_id || null, department_id: form.department_id || null, items: form.items.filter((i: any) => i.service_id || i.description).map((i: any) => ({ ...i, service_id: i.service_id || null, quantity: Number(i.quantity) })) }), { success: 'Laundry order created', invalidate: ['/laundry', '/folios'], onSuccess: () => { setOpen(false); refetch(); } });
  const svc: any[] = services?.data ?? [];
  const est = form.items.reduce((s: number, i: any) => { const sv = svc.find((x) => x.id === i.service_id); return s + (sv ? Number(sv.price) * Number(i.quantity || 0) * (form.express ? Number(sv.express_multiplier) : 1) : 0); }, 0);
  return <div className="space-y-4">
    <PageHeader title="Laundry" subtitle="Guest laundry posts to the folio on collection; linen and uniforms are tracked by department." actions={can('laundry.manage') && <Button onClick={() => setOpen(true)}><Plus />New laundry order</Button>} />
    <Tabs defaultValue="board"><TabsList><TabsTrigger value="board">Board {board && <Badge tone="muted" className="ml-1">{board.total}</Badge>}</TabsTrigger><TabsTrigger value="orders">All orders</TabsTrigger><TabsTrigger value="services">Price list</TabsTrigger></TabsList>
      <TabsContent value="board">{isLoading ? <Spinner /> : <div className="flex gap-3 overflow-x-auto pb-2">{(board?.columns ?? []).map((c: any, ci: number) => <div key={c.status} className="w-64 shrink-0 rounded-lg border bg-muted/30"><div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase"><span>{titleCase(c.status)}</span><Badge tone="muted">{c.orders.length}</Badge></div><div className="space-y-2 p-2 min-h-24">{c.orders.map((o: any) => { const next = FLOW[FLOW.indexOf(o.status) + 1]; const nextLabel = o.type === 'GUEST' ? (next === 'RETURNED_TO_STORE' ? null : next) : (next === 'DELIVERED' ? 'RETURNED_TO_STORE' : next); return <div key={o.id} className="rounded-md border bg-card p-2 text-sm shadow-sm"><div className="flex items-center justify-between"><span className="font-medium">{o.number}</span>{o.express && <Badge tone="destructive">Express</Badge>}</div><div className="text-xs text-muted-foreground">{o.type === 'GUEST' ? `Room ${o.room_number ?? '?'} · ${o.guest_name ?? ''}` : `${titleCase(o.type)} · ${o.department_name ?? ''}`}</div><div className="text-xs">{o.pieces ?? o.item_count} piece(s) · {fmtMoney(o.total, currency)} · {fmtTime(o.created_at)}</div>{nextLabel && can('laundry.manage') && <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => moveM.mutate({ id: o.id, status: nextLabel })}>{titleCase(nextLabel)} <ArrowRight /></Button>}</div>; })}</div></div>)}</div>}</TabsContent>
      <TabsContent value="orders"><DataTable path="/laundry" defaultSort="created_at" filters={[{ key: 'status', label: 'Status', type: 'select', options: FLOW.concat('CANCELLED') }, { key: 'type', label: 'Type', type: 'select', options: ['GUEST', 'HOTEL_LINEN', 'UNIFORM'] }]} columns={[{ key: 'number', label: 'Order' }, { key: 'type', label: 'Type', render: (r) => titleCase(r.type) }, { key: 'room_number', label: 'Room' }, { key: 'guest_name', label: 'Guest' }, { key: 'department_name', label: 'Department' }, { key: 'pieces', label: 'Pieces', type: 'number', decimals: 0 }, { key: 'total', label: 'Total', type: 'money' }, { key: 'express', label: 'Express', type: 'boolean' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }, { key: 'created_at', label: 'Collected', type: 'datetime' }]} /></TabsContent>
      <TabsContent value="services"><ResourcePage title="Laundry services" path="/laundry-services" permissions={{ create: 'laundry.manage', edit: 'laundry.manage' }} columns={[{ key: 'name', label: 'Service' }, { key: 'category', label: 'Category' }, { key: 'price', label: 'Price', type: 'money' }, { key: 'express_multiplier', label: 'Express ×', type: 'number' }, { key: 'is_active', label: 'Active', type: 'boolean' }]} fields={[{ name: 'name', label: 'Name', required: true }, { name: 'category', label: 'Category', type: 'select', options: ['GARMENT', 'LINEN', 'UNIFORM', 'DRY_CLEAN', 'PRESSING', 'OTHER'], default: 'GARMENT' }, { name: 'price', label: 'Price', type: 'money', required: true }, { name: 'express_multiplier', label: 'Express multiplier', type: 'number', default: 1.5 }, { name: 'is_active', label: 'Active', type: 'switch', default: true }]} /></TabsContent>
    </Tabs>
    <Modal open={open} onOpenChange={setOpen} title="New laundry order" size="lg"><div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="flex flex-col gap-1"><Label>Type</Label><NativeSelect value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{['GUEST', 'HOTEL_LINEN', 'UNIFORM'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</NativeSelect></div>
        {form.type === 'GUEST' ? <div className="flex flex-col gap-1 col-span-2"><Label>In-house guest</Label><LookupSelect source="/stays" sourceQuery={{ status: 'IN_HOUSE', pageSize: 200 }} sourceLabel={(s: any) => `Room ${s.room_number} · ${s.guest_name}`} value={form.stay_id} onChange={(v, row) => setForm({ ...form, stay_id: v, room_id: row?.room_id ?? '' })} /></div> : <div className="flex flex-col gap-1 col-span-2"><Label>Department</Label><LookupSelect source="/departments" value={form.department_id} onChange={(v) => setForm({ ...form, department_id: v })} /></div>}
        <label className="flex items-center gap-2 pt-6 text-sm"><Switch checked={form.express} onCheckedChange={(v) => setForm({ ...form, express: v })} /> Express</label>
      </div>
      <div className="rounded-md border"><table className="w-full text-sm"><thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr><th className="px-2 py-1 text-left">Service</th><th className="px-2 py-1 text-left">Description</th><th className="px-2 py-1 w-20">Qty</th><th className="w-8" /></tr></thead><tbody>{form.items.map((it: any, i: number) => <tr key={i} className="border-t"><td className="p-1"><NativeSelect value={it.service_id} onChange={(e) => setForm({ ...form, items: form.items.map((x: any, j: number) => (j === i ? { ...x, service_id: e.target.value } : x)) })}><option value="">Custom…</option>{svc.map((s) => <option key={s.id} value={s.id}>{s.name} · {fmtMoney(s.price, currency)}</option>)}</NativeSelect></td><td className="p-1"><Input value={it.description} onChange={(e) => setForm({ ...form, items: form.items.map((x: any, j: number) => (j === i ? { ...x, description: e.target.value } : x)) })} placeholder="e.g. 2 shirts, 1 trouser" /></td><td className="p-1"><Input type="number" min={1} value={it.quantity} onChange={(e) => setForm({ ...form, items: form.items.map((x: any, j: number) => (j === i ? { ...x, quantity: e.target.value } : x)) })} /></td><td className="p-1"><Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setForm({ ...form, items: form.items.filter((_: any, j: number) => j !== i) })}>×</Button></td></tr>)}</tbody></table><div className="p-2"><Button size="sm" variant="outline" onClick={() => setForm({ ...form, items: [...form.items, { service_id: '', description: '', quantity: 1 }] })}><Plus />Add line</Button></div></div>
      <div className="flex flex-col gap-1"><Label>Notes</Label><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
      <div className="flex items-center justify-between">{form.type === 'GUEST' ? <label className="flex items-center gap-2 text-sm"><Switch checked={form.charge_now} onCheckedChange={(v) => setForm({ ...form, charge_now: v })} /> Charge guest folio now (est. {fmtMoney(est, currency)})</label> : <span className="text-sm text-muted-foreground">Internal laundry — no guest charge</span>}<Button loading={createM.isPending} disabled={form.items.length === 0 || (form.type === 'GUEST' && !form.stay_id)} onClick={() => createM.mutate(undefined as any)}><Shirt />Create order</Button></div>
    </div></Modal>
  </div>;
}
