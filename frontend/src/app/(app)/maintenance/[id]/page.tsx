'use client';
import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, UserCheck, Play, Pause, Package, ShieldCheck, X, ThumbsUp, ThumbsDown } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { FormDialog, ConfirmDialog } from '@/components/shared/form';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { LookupSelect } from '@/components/shared/form';
import { fmtDateTime, fmtMoney, titleCase } from '@/lib/utils';
import { Attachments } from '@/components/shared/attachments';
import { ApprovalTrail } from '@/components/shared/approval-trail';

export default function MaintenanceDetail() {
  const { id } = useParams<{ id: string }>(); const { can, currency } = useAuth();
  const { data: m, isLoading, refetch } = useApi<any>(`/maintenance/${id}`);
  const [dlg, setDlg] = useState<string | null>(null); const [parts, setParts] = useState<{ store_id: string; items: { product_id: string; quantity: number | string }[] }>({ store_id: '', items: [{ product_id: '', quantity: 1 }] });
  const inv = ['/maintenance', '/rooms', '/stock', '/dashboard'];
  const useAct = (path: string, msg: string) => useAction((v: any) => post(`/maintenance/${id}/${path}`, v ?? {}), { success: msg, invalidate: inv, onSuccess: () => { setDlg(null); refetch(); } });
  const approveM = useAct('approve', 'Approved'), rejectM = useAct('reject', 'Rejected'), assignM = useAct('assign', 'Assigned'), startM = useAct('start', 'Work started'), holdM = useAct('hold', 'Put on hold'), completeM = useAct('complete', 'Work completed'), verifyM = useAct('verify', 'Verified'), cancelM = useAct('cancel', 'Cancelled');
  const partsM = useAction(() => post(`/maintenance/${id}/parts`, { store_id: parts.store_id, items: parts.items.filter((i) => i.product_id).map((i) => ({ product_id: i.product_id, quantity: Number(i.quantity) })) }), { success: 'Parts issued from store (stock ledger updated)', invalidate: inv, onSuccess: () => { setDlg(null); refetch(); } });
  if (isLoading || !m) return <Spinner />;
  const st = m.status;
  return <div className="space-y-4">
    <PageHeader crumbs={[{ label: 'Maintenance', href: '/maintenance' }, { label: m.number }]} title={<span className="flex items-center gap-2">{m.number} · {m.title} <StatusBadge status={st} /><Badge tone={m.priority === 'URGENT' ? 'destructive' : m.priority === 'HIGH' ? 'warning' : 'muted'}>{m.priority}</Badge></span>} subtitle={`${titleCase(m.category)} · ${m.room_number ? `Room ${m.room_number}` : m.asset_name ?? m.location ?? titleCase(m.location_type)} · reported by ${m.reported_by_name} ${fmtDateTime(m.created_at)}`}
      actions={<>
        {st === 'REPORTED' && can('maintenance.approve') && <><Button variant="outline" onClick={() => setDlg('reject')}><ThumbsDown />Reject</Button><Button onClick={() => approveM.mutate({})}><ThumbsUp />Approve</Button></>}
        {['APPROVED', 'ASSIGNED', 'REPORTED'].includes(st) && can('maintenance.assign') && <Button variant={st === 'APPROVED' ? 'default' : 'outline'} onClick={() => setDlg('assign')}><UserCheck />{st === 'ASSIGNED' ? 'Re-assign' : 'Assign'}</Button>}
        {['ASSIGNED', 'ON_HOLD', 'APPROVED'].includes(st) && can('maintenance.work') && <Button onClick={() => startM.mutate({})}><Play />Start work</Button>}
        {st === 'IN_PROGRESS' && can('maintenance.work') && <><Button variant="outline" onClick={() => setDlg('hold')}><Pause />Hold</Button><Button variant="outline" onClick={() => setDlg('parts')}><Package />Issue parts</Button><Button onClick={() => setDlg('complete')}><Check />Complete</Button></>}
        {st === 'COMPLETED' && can('maintenance.verify') && <Button onClick={() => setDlg('verify')}><ShieldCheck />Verify</Button>}
        {!['COMPLETED', 'VERIFIED', 'REJECTED', 'CANCELLED'].includes(st) && can('maintenance.approve') && <Button variant="ghost" onClick={() => setDlg('cancel')}><X />Cancel</Button>}
      </>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <Section title="Details" className="lg:col-span-2"><KV cols={3} items={[['Description', m.description ?? '—'], ['Location', m.location ?? '—'], ['Blocks room', m.blocks_room ? 'Yes (room out of order)' : 'No'], ['Assigned to', m.assigned_to_name ?? m.contractor_name ?? '—'], ['Approved by', m.approved_by_name ?? '—'], ['Estimated cost', fmtMoney(m.estimated_cost, currency)], ['Labour', `${m.labour_hours ?? 0} h · ${fmtMoney(m.labour_cost, currency)}`], ['Parts cost', fmtMoney(m.parts_cost, currency)], ['Contractor cost', fmtMoney(m.contractor_cost, currency)], ['Total cost', fmtMoney(m.total_cost, currency)], ['Started', m.started_at ? fmtDateTime(m.started_at) : '—'], ['Completed', m.completed_at ? fmtDateTime(m.completed_at) : '—'], ['Resolution', m.resolution ?? '—']]} />
        {m.parts?.length > 0 && <div className="mt-3"><div className="text-xs uppercase text-muted-foreground mb-1">Parts used</div><table className="w-full text-sm"><tbody className="divide-y">{m.parts.map((p: any) => <tr key={p.id}><td className="py-1">{p.product_name ?? p.description} <span className="text-xs text-muted-foreground">{p.sku}</span></td><td className="py-1 text-right tabular">{p.quantity} {p.unit}</td><td className="py-1 text-right tabular">{fmtMoney(p.total_cost ?? p.unit_cost * p.quantity, currency)}</td></tr>)}</tbody></table></div>}
      </Section>
      <div className="space-y-4">
        <ApprovalTrail approval={m.approval} />
        <Section title="History"><ul className="text-sm space-y-1 max-h-80 overflow-y-auto">{(m.history ?? []).map((h: any) => <li key={h.id}><span className="text-xs text-muted-foreground">{fmtDateTime(h.created_at)}</span> <b>{titleCase(h.action ?? h.status)}</b>{h.user_name ? ` · ${h.user_name}` : ''}{h.notes ? <div className="text-muted-foreground">{h.notes}</div> : null}</li>)}</ul></Section>
      </div>
    </div>
    <Attachments entity="maintenance_request" entityId={id} title="Photos & documents" />
    <FormDialog open={dlg === 'assign'} onOpenChange={(o) => !o && setDlg(null)} title="Assign work order" size="sm" cols={1} fields={[{ name: 'assigned_to', label: 'Technician', type: 'lookup', source: '/users', sourceLabel: 'full_name', sourceQuery: { pageSize: 200 } }, { name: 'contractor_name', label: 'External contractor (optional)' }, { name: 'contractor_cost', label: 'Contractor quote', type: 'money' }, { name: 'blocks_room', label: 'Take room out of order', type: 'switch' }, { name: 'notes', label: 'Instructions', type: 'textarea' }]} onSubmit={(v) => assignM.mutateAsync({ ...v, assigned_to: v.assigned_to || null })} />
    <FormDialog open={dlg === 'complete'} onOpenChange={(o) => !o && setDlg(null)} title="Complete work order" size="md" fields={[{ name: 'resolution', label: 'Resolution', type: 'textarea', required: true, col: 2 }, { name: 'labour_hours', label: 'Labour hours', type: 'number' }, { name: 'labour_cost', label: 'Labour cost', type: 'money' }, { name: 'contractor_cost', label: 'Contractor cost', type: 'money' }, { name: 'notes', label: 'Notes' }]} onSubmit={(v) => completeM.mutateAsync(v)} />
    <FormDialog open={dlg === 'verify'} onOpenChange={(o) => !o && setDlg(null)} title="Verify completed work" size="sm" cols={1} initial={{ passed: true }} fields={[{ name: 'passed', label: 'Work verified OK (room returns to service)', type: 'switch' }, { name: 'notes', label: 'Notes', type: 'textarea' }]} onSubmit={(v) => verifyM.mutateAsync(v)} />
    <ConfirmDialog open={dlg === 'reject'} onOpenChange={(o) => !o && setDlg(null)} title="Reject request" destructive confirmLabel="Reject" fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]} onConfirm={(v) => rejectM.mutateAsync(v)} />
    <ConfirmDialog open={dlg === 'hold'} onOpenChange={(o) => !o && setDlg(null)} title="Put on hold" confirmLabel="Hold" fields={[{ name: 'reason', label: 'Reason (e.g. waiting for parts)', type: 'textarea', required: true }]} onConfirm={(v) => holdM.mutateAsync(v)} />
    <ConfirmDialog open={dlg === 'cancel'} onOpenChange={(o) => !o && setDlg(null)} title="Cancel work order" destructive confirmLabel="Cancel work order" fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]} onConfirm={(v) => cancelM.mutateAsync(v)} />
    <Modal open={dlg === 'parts'} onOpenChange={(o) => !o && setDlg(null)} title="Issue spare parts from store" size="md"><div className="space-y-3">
      <div className="flex flex-col gap-1"><Label>Store</Label><LookupSelect source="/stores" value={parts.store_id} onChange={(v) => setParts({ ...parts, store_id: v })} /></div>
      {parts.items.map((it, i) => <div key={i} className="grid grid-cols-[1fr_90px_32px] gap-2 items-end"><div className="flex flex-col gap-1"><Label>Product</Label><LookupSelect source="/products" sourceQuery={{ pageSize: 500 }} sourceLabel={(p: any) => `${p.sku ?? ''} ${p.name}`} value={it.product_id} onChange={(v) => setParts({ ...parts, items: parts.items.map((x, j) => (j === i ? { ...x, product_id: v } : x)) })} /></div><div className="flex flex-col gap-1"><Label>Qty</Label><Input type="number" min={0.01} step="0.01" value={it.quantity} onChange={(e) => setParts({ ...parts, items: parts.items.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} /></div><Button size="icon" variant="ghost" onClick={() => setParts({ ...parts, items: parts.items.filter((_, j) => j !== i) })}>×</Button></div>)}
      <div className="flex justify-between"><Button size="sm" variant="outline" onClick={() => setParts({ ...parts, items: [...parts.items, { product_id: '', quantity: 1 }] })}>Add line</Button><Button loading={partsM.isPending} disabled={!parts.store_id || !parts.items.some((i) => i.product_id)} onClick={() => partsM.mutate(undefined as any)}><Package />Issue parts</Button></div>
    </div></Modal>
  </div>;
}
