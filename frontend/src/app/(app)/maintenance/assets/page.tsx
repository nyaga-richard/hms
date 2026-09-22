'use client';
import React, { useState } from 'react';
import { Package, MoveRight, ScanLine, Wrench } from 'lucide-react';
import { post, get } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { ResourcePage } from '@/components/shared/resource-page';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Modal } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FormDialog, type Field } from '@/components/shared/form';
import { DropdownMenuItem } from '@/components/ui/dropdown';
import { Attachments } from '@/components/shared/attachments';
import { fmtDate, fmtDateTime, fmtMoney, titleCase } from '@/lib/utils';
import { ReportIssueDialog } from '../maintenance-view';

const STATUSES = ['IN_USE', 'IN_STORE', 'UNDER_MAINTENANCE', 'DAMAGED', 'DISPOSED', 'LOST'];
const assetFields: Field[] = [{ name: 'name', label: 'Asset name', required: true }, { name: 'category_id', label: 'Category', type: 'lookup' as const, source: '/asset-categories' }, { name: 'serial_number', label: 'Serial number' }, { name: 'model', label: 'Model' }, { name: 'room_id', label: 'Room', type: 'lookup' as const, source: '/rooms', sourceLabel: 'number' }, { name: 'department_id', label: 'Department', type: 'lookup' as const, source: '/departments' }, { name: 'location', label: 'Location (free text)' }, { name: 'supplier_id', label: 'Supplier', type: 'lookup' as const, source: '/suppliers' }, { name: 'purchase_date', label: 'Purchase date', type: 'date' as const }, { name: 'cost', label: 'Cost', type: 'money' as const }, { name: 'warranty_expiry', label: 'Warranty expiry', type: 'date' as const }, { name: 'status', label: 'Status', type: 'select' as const, options: STATUSES, default: 'IN_USE' }, { name: 'responsible_user_id', label: 'Responsible user', type: 'lookup' as const, source: '/users', sourceLabel: 'full_name' }, { name: 'barcode', label: 'Barcode / tag' }, { name: 'notes', label: 'Notes', type: 'textarea' as const, col: 2 }];
export default function AssetsPage() {
  const { can, currency } = useAuth(); const { data: sum } = useApi<any>('/assets/summary');
  const [move, setMove] = useState<any>(null); const [detail, setDetail] = useState<any>(null); const [issue, setIssue] = useState<any>(null); const [scan, setScan] = useState(''); const [tick, setTick] = useState(0);
  const moveM = useAction((v: any) => post(`/assets/${move.id}/move`, v), { success: 'Asset moved', invalidate: ['/assets'], onSuccess: () => { setMove(null); setTick((t) => t + 1); } });
  const lookup = async () => { if (!scan.trim()) return; try { const a = await get(`/assets/lookup/${encodeURIComponent(scan.trim())}`); setDetail(a); setScan(''); } catch { /* toast from api */ } };
  return <div className="space-y-4">
    <Tabs defaultValue="register"><TabsList><TabsTrigger value="register">Asset register</TabsTrigger><TabsTrigger value="categories">Categories</TabsTrigger></TabsList>
      <TabsContent value="register" className="space-y-4">
        <div className="grid gap-3 md:grid-cols-4">{(sum?.by_status ?? []).slice(0, 4).map((s: any) => <div key={s.status} className="rounded-lg border bg-card p-3"><div className="text-xs text-muted-foreground">{titleCase(s.status)}</div><div className="text-2xl font-semibold tabular">{s.count}</div><div className="text-xs text-muted-foreground">{fmtMoney(s.cost, currency)}</div></div>)}</div>
        {(sum?.warranty_expiring ?? []).length > 0 && <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm"><b>Warranty expiring soon:</b> {sum.warranty_expiring.map((a: any) => `${a.name} (${fmtDate(a.warranty_expiry)})`).join(', ')}</div>}
        <ResourcePage key={tick} title="Assets" subtitle="Fixed-asset register with location history, barcode lookup and maintenance link." path="/assets" entity="asset" permissions={{ create: 'assets.manage', edit: 'assets.manage' }} searchPlaceholder="Search name, number, serial, barcode…" defaultSort="asset_number" dialogSize="lg"
          headerActions={<form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); lookup(); }}><Input className="w-44" placeholder="Scan tag / number" value={scan} onChange={(e) => setScan(e.target.value)} /><Button type="submit" variant="outline"><ScanLine />Lookup</Button></form>}
          filters={[{ key: 'status', label: 'Status', type: 'select', options: STATUSES }, { key: 'category_id', label: 'Category', type: 'select', source: '/asset-categories' }, { key: 'department_id', label: 'Department', type: 'select', source: '/departments' }]}
          columns={[{ key: 'asset_number', label: 'No.' }, { key: 'name', label: 'Asset', render: (r) => <button type="button" className="text-left font-medium hover:underline" onClick={async (e) => { e.stopPropagation(); setDetail(await get(`/assets/${r.id}`)); }}>{r.name}</button> }, { key: 'category_name', label: 'Category' }, { key: 'serial_number', label: 'Serial' }, { key: 'room_number', label: 'Room' }, { key: 'department_name', label: 'Department' }, { key: 'location', label: 'Location' }, { key: 'cost', label: 'Cost', type: 'money' }, { key: 'warranty_expiry', label: 'Warranty', type: 'date' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]}
          fields={assetFields} extraActions={(row) => <>{can('assets.manage') && <DropdownMenuItem onClick={() => setMove(row)}><MoveRight />Move / change status</DropdownMenuItem>}{can('maintenance.create') && <DropdownMenuItem onClick={() => setIssue(row)}><Wrench />Report issue</DropdownMenuItem>}</>} />
      </TabsContent>
      <TabsContent value="categories"><ResourcePage title="Asset categories" path="/asset-categories" permissions={{ create: 'assets.manage', edit: 'assets.manage', delete: 'assets.manage' }} columns={[{ key: 'name', label: 'Category' }, { key: 'depreciation_rate', label: 'Depreciation %/yr', type: 'number' }, { key: 'account_name', label: 'Asset account' }]} fields={[{ name: 'name', label: 'Name', required: true }, { name: 'depreciation_rate', label: 'Depreciation rate (%/year)', type: 'number', default: 0 }, { name: 'account_id', label: 'Asset GL account', type: 'lookup', source: '/accounts', sourceQuery: { type: 'ASSET' }, sourceLabel: (a: any) => `${a.code} ${a.name}` }]} /></TabsContent>
    </Tabs>
    <FormDialog open={!!move} onOpenChange={(o) => !o && setMove(null)} title={move ? `Move ${move.name}` : ''} size="sm" initial={move ? { location: move.location, department_id: move.department_id, room_id: move.room_id, status: move.status } : undefined} fields={[{ name: 'room_id', label: 'Room', type: 'lookup', source: '/rooms', sourceLabel: 'number' }, { name: 'department_id', label: 'Department', type: 'lookup', source: '/departments' }, { name: 'location', label: 'Location', col: 2 }, { name: 'status', label: 'Status', type: 'select', options: STATUSES }, { name: 'reason', label: 'Reason', required: true, col: 2 }]} onSubmit={(v) => moveM.mutateAsync(v)} />
    <Modal open={!!detail} onOpenChange={(o) => !o && setDetail(null)} title={detail ? <span className="flex items-center gap-2"><Package className="h-4 w-4" />{detail.asset_number} · {detail.name} <StatusBadge status={detail.status} /></span> : ''} size="lg">{detail && <div className="space-y-4">
      <KV items={[['Category', detail.category_name ?? '—'], ['Serial / model', [detail.serial_number, detail.model].filter(Boolean).join(' · ') || '—'], ['Location', [detail.room_number && `Room ${detail.room_number}`, detail.department_name, detail.location].filter(Boolean).join(' · ') || '—'], ['Supplier', detail.supplier_name ?? '—'], ['Purchased', `${fmtDate(detail.purchase_date)} · ${fmtMoney(detail.cost, currency)}`], ['Warranty', fmtDate(detail.warranty_expiry)], ['Responsible', detail.responsible_name ?? '—'], ['Barcode', detail.barcode ?? '—']]} />
      <Section title="Movement history"><ul className="divide-y text-sm">{(detail.movements ?? []).map((m: any) => <li key={m.id} className="py-1.5"><span className="text-xs text-muted-foreground">{fmtDateTime(m.created_at)}</span> {[m.from_room && `Rm ${m.from_room}`, m.from_department, m.from_location].filter(Boolean).join('/') || 'unassigned'} → <b>{[m.to_room && `Rm ${m.to_room}`, m.to_department, m.to_location].filter(Boolean).join('/') || 'unassigned'}</b>{m.status_after && <Badge tone="muted" className="ml-2">{titleCase(m.status_after)}</Badge>}<div className="text-xs text-muted-foreground">{m.reason} · {m.user_name}</div></li>)}{(detail.movements ?? []).length === 0 && <li className="py-2 text-muted-foreground">No movements recorded.</li>}</ul></Section>
      <Section title="Maintenance history"><ul className="divide-y text-sm">{(detail.maintenance ?? []).map((w: any) => <li key={w.id} className="flex justify-between py-1.5"><a className="hover:underline" href={`/maintenance/${w.id}`}>{w.number} · {w.title}</a><span className="flex items-center gap-2 text-xs text-muted-foreground">{fmtDate(w.created_at)}<StatusBadge status={w.status} /></span></li>)}{(detail.maintenance ?? []).length === 0 && <li className="py-2 text-muted-foreground">No work orders for this asset.</li>}</ul></Section>
      <Attachments entity="asset" entityId={detail.id} title="Invoices, warranty cards & photos" />
    </div>}</Modal>
    {issue && <ReportIssueDialog open={!!issue} onOpenChange={(o) => !o && setIssue(null)} assetId={issue.id} roomId={issue.room_id ?? null} />}
  </div>;
}
