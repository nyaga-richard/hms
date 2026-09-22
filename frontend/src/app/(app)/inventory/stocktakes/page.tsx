'use client';
import React, { useMemo, useState } from 'react';
import { Plus, ClipboardList, Save, Send, Check, RotateCcw, X } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, KV } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { FormDialog, ConfirmDialog } from '@/components/shared/form';
import { ProductSearch } from '@/components/inventory/product-lines';
import { AuditTrail } from '@/components/shared/audit-trail';
import { fmtDateTime, fmtMoney, fmtNum } from '@/lib/utils';

/** Count sheet: system qty is frozen at snapshot; blind counting hides it until submitted for review. */
function StocktakeDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, currency } = useAuth(); const { data: st, refetch } = useApi<any>(id ? `/stocktakes/${id}` : null);
  const [counts, setCounts] = useState<Record<string, string>>({}); const [blind, setBlind] = useState(true); const [filter, setFilter] = useState(''); const [onlyUncounted, setOnlyUncounted] = useState(false); const [cancel, setCancel] = useState(false); const [approve, setApprove] = useState(false);
  const inv = ['/stocktakes', '/stock', '/stock-adjustments', '/approvals'];
  const dirty = Object.keys(counts).length;
  const saveM = useAction(() => post(`/stocktakes/${id}/count`, { items: Object.entries(counts).map(([iid, q]) => ({ id: iid, counted_qty: Number(q) })) }), { success: 'Counts saved', invalidate: ['/stocktakes'], onSuccess: () => { setCounts({}); refetch(); } });
  const submitM = useAction(() => post(`/stocktakes/${id}/submit`), { success: 'Submitted for review', invalidate: inv, onSuccess: () => refetch() });
  const approveM = useAction((v: any) => post(`/stocktakes/${id}/approve`, v), { success: 'Stocktake approved — variances posted', invalidate: inv, onSuccess: () => { setApprove(false); refetch(); } });
  const reopenM = useAction(() => post(`/stocktakes/${id}/reopen`), { success: 'Reopened for counting', invalidate: inv, onSuccess: () => refetch() });
  const cancelM = useAction((v: any) => post(`/stocktakes/${id}/cancel`, v), { success: 'Cancelled', invalidate: inv, onSuccess: () => { setCancel(false); refetch(); } });
  const items: any[] = useMemo(() => (st?.items ?? []).filter((i: any) => (!filter || `${i.product_name} ${i.sku} ${i.barcode ?? ''} ${i.category_name}`.toLowerCase().includes(filter.toLowerCase())) && (!onlyUncounted || i.counted_qty == null)), [st, filter, onlyUncounted]);
  if (!id) return null; const counting = st?.status === 'COUNTING'; const showSystem = !blind || !counting;
  const totalVar = (st?.items ?? []).reduce((s: number, i: any) => s + Number(i.variance_qty ?? 0) * Number(i.unit_cost ?? 0), 0);
  return <Modal open={!!id} onOpenChange={(o) => !o && (dirty === 0 || confirm('Discard unsaved counts?')) && onClose()} title={st ? <span className="flex items-center gap-2"><ClipboardList className="h-4 w-4" />{st.number} · {st.store_name} <StatusBadge status={st.status} /></span> : 'Stocktake'} size="xl">{st && <div className="space-y-3">
    <KV cols={4} items={[['Snapshot', fmtDateTime(st.snapshot_at)], ['Progress', `${st.counted_count ?? (st.items ?? []).filter((i: any) => i.counted_qty != null).length} / ${st.item_count ?? (st.items ?? []).length} counted`], ['Variance value', <span key="v" className={totalVar < 0 ? 'text-destructive' : ''}>{showSystem ? fmtMoney(totalVar, currency) : 'hidden (blind)'}</span>], ['Created', `${st.created_by_name} · ${fmtDateTime(st.created_at)}`]]} />
    <div className="flex flex-wrap items-center gap-2"><Input className="w-64" placeholder="Filter product / SKU / category" value={filter} onChange={(e) => setFilter(e.target.value)} /><label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={onlyUncounted} onChange={(e) => setOnlyUncounted(e.target.checked)} /> Uncounted only</label>{counting && <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> Blind count (hide system qty)</label>}{counting && <div className="ml-auto w-72"><ProductSearch placeholder="Scan barcode to jump to line…" onPick={(p) => { setFilter(p.sku); }} /></div>}</div>
    <div className="max-h-[50vh] overflow-auto rounded-md border"><table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-xs uppercase text-muted-foreground"><tr><th className="p-2 text-left">Product</th><th className="p-2 text-left">Category</th>{showSystem && <th className="p-2 text-right">System</th>}<th className="p-2 text-right w-36">Counted</th>{showSystem && <><th className="p-2 text-right">Variance</th><th className="p-2 text-right">Value</th></>}<th className="p-2 text-left">Notes</th></tr></thead>
      <tbody className="divide-y">{items.map((i: any) => { const c = counts[i.id] ?? (i.counted_qty ?? ''); const v = c === '' ? null : Number(c) - Number(i.system_qty); return <tr key={i.id} className={i.counted_qty == null && counts[i.id] === undefined ? 'bg-amber-500/5' : ''}><td className="p-2"><div className="font-medium">{i.product_name}</div><div className="text-xs text-muted-foreground">{i.sku} · {i.unit}</div></td><td className="p-2 text-xs">{i.category_name}</td>{showSystem && <td className="p-2 text-right tabular">{fmtNum(i.system_qty, 3)}</td>}<td className="p-2">{counting && can('inventory.stocktake') ? <Input type="number" step="any" min={0} className="text-right" value={c} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value })} /> : <span className="block text-right tabular">{i.counted_qty == null ? '—' : fmtNum(i.counted_qty, 3)}</span>}</td>{showSystem && <><td className={`p-2 text-right tabular ${v && v < 0 ? 'text-destructive' : v && v > 0 ? 'text-emerald-600' : ''}`}>{v == null ? '—' : `${v > 0 ? '+' : ''}${fmtNum(v, 3)}`}</td><td className="p-2 text-right tabular">{v == null ? '—' : fmtMoney(v * Number(i.unit_cost ?? 0), currency)}</td></>}<td className="p-2 text-xs text-muted-foreground">{i.notes}</td></tr>; })}{items.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No lines match.</td></tr>}</tbody></table></div>
    <div className="flex flex-wrap items-center gap-2">
      {counting && can('inventory.stocktake') && <><Button loading={saveM.isPending} disabled={dirty === 0} onClick={() => saveM.mutate(undefined as any)}><Save />Save counts ({dirty})</Button><Button variant="outline" disabled={dirty > 0} onClick={() => submitM.mutate(undefined as any)}><Send />Submit for review</Button></>}
      {st.status === 'REVIEW' && can('inventory.approve_stocktake') && <><Button onClick={() => setApprove(true)}><Check />Approve & post variances</Button><Button variant="outline" onClick={() => reopenM.mutate(undefined as any)}><RotateCcw />Reopen counting</Button></>}
      {['COUNTING', 'REVIEW'].includes(st.status) && can('inventory.stocktake') && <Button variant="ghost" onClick={() => setCancel(true)}><X />Cancel stocktake</Button>}
      {st.adjustment_id && <span className="text-xs text-muted-foreground">Variance adjustment posted · <a className="underline" href="/inventory/adjustments">view adjustments</a></span>}
    </div>
    <AuditTrail entity="stocktake" entityId={id} />
    <ConfirmDialog open={approve} onOpenChange={setApprove} title="Approve stocktake?" description={`Variances totalling ${fmtMoney(totalVar, currency)} will be posted as a stock adjustment with a journal entry. Uncounted lines are left unchanged.`} confirmLabel="Approve & post" fields={[{ name: 'notes', label: 'Notes' }]} onConfirm={(v) => approveM.mutateAsync(v)} />
    <ConfirmDialog open={cancel} onOpenChange={setCancel} title="Cancel stocktake" destructive confirmLabel="Cancel stocktake" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => cancelM.mutateAsync(v)} />
  </div>}</Modal>;
}
export default function StocktakesPage() {
  const { can } = useAuth(); const [open, setOpen] = useState(false); const [sel, setSel] = useState<string | null>(null);
  const create = useAction((v: any) => post('/stocktakes', v), { success: 'Stocktake opened — system quantities snapshotted', invalidate: ['/stocktakes'], onSuccess: (s: any) => setSel(s.id) });
  return <div className="space-y-4">
    <PageHeader title="Stocktakes" subtitle="Physical counts per store: snapshot → blind count → review → approval posts variances as an adjustment." actions={can('inventory.stocktake') && <Button onClick={() => setOpen(true)}><Plus />Start stocktake</Button>} />
    <DataTable path="/stocktakes" defaultSort="created_at" onRowClick={(r) => setSel(r.id)} filters={[{ key: 'status', label: 'Status', type: 'select', options: ['COUNTING', 'REVIEW', 'POSTED', 'CANCELLED'] }, { key: 'store_id', label: 'Store', type: 'select', source: '/stores' }]}
      columns={[{ key: 'number', label: 'No.' }, { key: 'snapshot_at', label: 'Snapshot', type: 'datetime' }, { key: 'store_name', label: 'Store' }, { key: 'item_count', label: 'Lines', type: 'number', decimals: 0 }, { key: 'counted_count', label: 'Counted', render: (r) => <span className="tabular">{r.counted_count}/{r.item_count}</span> }, { key: 'variance_value', label: 'Variance', type: 'money' }, { key: 'created_by_name', label: 'By' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} />
    <FormDialog open={open} onOpenChange={setOpen} title="Start stocktake" description="One open stocktake per store. Movements after the snapshot are reconciled at approval." size="sm" fields={[{ name: 'store_id', label: 'Store', type: 'lookup', source: '/stores', required: true }, { name: 'category_id', label: 'Limit to category (optional)', type: 'lookup', source: '/product-categories' }, { name: 'include_zero', label: 'Include zero-balance products', type: 'switch' }, { name: 'notes', label: 'Notes', type: 'textarea', col: 2 }]} onSubmit={(v) => create.mutateAsync(v)} />
    <StocktakeDetail id={sel} onClose={() => setSel(null)} />
  </div>;
}
