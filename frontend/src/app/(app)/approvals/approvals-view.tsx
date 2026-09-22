'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { Check, X, Undo2, ExternalLink, Inbox } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/shared/form';
import { fmtDateTime, fmtMoney, titleCase } from '@/lib/utils';

/** Where each approvable document lives in the app — the inbox deep-links straight into the record. */
export const ENTITY_LINKS: Record<string, (id: string) => string> = {
  purchase_requisition: (id) => `/procurement?id=${id}`, purchase_order: (id) => `/procurement/purchase-orders?id=${id}`, supplier_payment_request: (id) => `/procurement/supplier-payments?id=${id}`, supplier_invoice: (id) => `/procurement/supplier-invoices?id=${id}`,
  stock_requisition: (id) => `/inventory/requisitions?id=${id}`, stock_adjustment: (id) => `/inventory/adjustments?id=${id}`, stocktake: (id) => `/inventory/stocktakes?id=${id}`, expense: (id) => `/finance/expenses?id=${id}`, maintenance_request: (id) => `/maintenance/${id}`, cashier_shift: (id) => `/pos/shifts?id=${id}`,
};
export function ApprovalsPage() {
  const { can, currency } = useAuth(); const { data, refetch, isLoading } = useApi<any>('/approvals'); const [act, setAct] = useState<{ row: any; action: 'APPROVE' | 'REJECT' | 'RETURN' } | null>(null); const [tick, setTick] = useState(0);
  const actM = useAction((v: any) => post(`/approvals/${act!.row.id}/act`, { action: act!.action, comment: v.comment || undefined }), { success: 'Decision recorded', invalidate: ['/approvals', '/notifications'], onSuccess: () => { setAct(null); refetch(); setTick((t) => t + 1); } });
  const rows: any[] = data?.data ?? []; const groups = rows.reduce<Record<string, any[]>>((g, r) => { (g[r.transaction_type] ??= []).push(r); return g; }, {});
  return <div className="space-y-4">
    <PageHeader title="Approvals" subtitle="Everything routed to you by the configurable workflows — requisitions, purchase orders, supplier payments, expenses, adjustments. Approve here or open the document for full context." />
    <Tabs defaultValue="inbox"><TabsList><TabsTrigger value="inbox">My inbox <Badge tone={rows.length ? 'warning' : 'muted'} className="ml-1">{rows.length}</Badge></TabsTrigger><TabsTrigger value="history">History</TabsTrigger></TabsList>
      <TabsContent value="inbox">{!isLoading && rows.length === 0 ? <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground"><Inbox className="mx-auto mb-2 h-8 w-8" />Nothing waiting for your approval.</div> : <div className="space-y-4">{Object.entries(groups).map(([type, list]) => <section key={type} className="rounded-lg border bg-card"><header className="border-b px-4 py-2 text-sm font-semibold">{titleCase(type)} <span className="text-xs font-normal text-muted-foreground">({list.length})</span></header><ul className="divide-y">{list.map((r) => { const link = ENTITY_LINKS[r.entity_type]?.(r.entity_id); return <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2 font-medium">{r.entity_number ?? r.entity_id.slice(0, 8)}{link && <Link href={link} className="text-primary" title="Open document"><ExternalLink className="h-3.5 w-3.5" /></Link>}<Badge tone="muted">step {r.current_step}/{r.total_steps}: {r.step_name}</Badge></div><div className="text-xs text-muted-foreground">Requested by {r.requested_by_name} · {fmtDateTime(r.requested_at)}{r.required_permission && ` · needs ${r.required_permission}`}</div></div><div className="text-right font-semibold tabular">{Number(r.amount) ? fmtMoney(r.amount, currency) : ''}</div>{can('approvals.act') && <div className="flex gap-1"><Button size="sm" onClick={() => setAct({ row: r, action: 'APPROVE' })}><Check />Approve</Button><Button size="sm" variant="outline" onClick={() => setAct({ row: r, action: 'RETURN' })}><Undo2 />Return</Button><Button size="sm" variant="ghost" className="text-destructive" onClick={() => setAct({ row: r, action: 'REJECT' })}><X />Reject</Button></div>}</li>; })}</ul></section>)}</div>}</TabsContent>
      <TabsContent value="history"><DataTable path="/approvals/history" defaultSort="requested_at" refreshKey={tick} noSearch exportName="approvals" columns={[{ key: 'requested_at', label: 'Requested', type: 'datetime' }, { key: 'transaction_type', label: 'Type', render: (r) => titleCase(r.transaction_type) }, { key: 'entity_number', label: 'Document', render: (r) => { const l = ENTITY_LINKS[r.entity_type]?.(r.entity_id); return l ? <Link href={l} className="underline">{r.entity_number ?? r.entity_id.slice(0, 8)}</Link> : r.entity_number; } }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'requested_by_name', label: 'Requested by' }, { key: 'current_step', label: 'Progress', render: (r) => `${Math.min(r.current_step, r.total_steps)}/${r.total_steps}` }, { key: 'actions', label: 'Decisions', render: (r) => <div className="space-y-0.5 text-xs">{(r.actions ?? []).map((a: any, i: number) => <div key={i}><StatusBadge status={a.action} className="mr-1" />{a.user} · {fmtDateTime(a.at)}{a.comment && <span className="text-muted-foreground"> — {a.comment}</span>}</div>)}</div> }, { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]} /></TabsContent>
    </Tabs>
    <ConfirmDialog open={!!act} onOpenChange={(o) => !o && setAct(null)} title={act ? `${titleCase(act.action)} ${act.row.entity_number ?? ''}` : ''} description={act?.action === 'APPROVE' ? 'Advances the workflow; when the final step approves, the document\u2019s effect (PO release, payment, stock posting…) is executed automatically.' : act?.action === 'RETURN' ? 'Sends the document back to the requester for changes.' : 'Rejects the request; the requester is notified.'} destructive={act?.action === 'REJECT'} confirmLabel={act ? titleCase(act.action) : 'OK'} fields={[{ name: 'comment', label: act?.action === 'APPROVE' ? 'Comment (optional)' : 'Reason', required: act?.action !== 'APPROVE', type: 'textarea', col: 2 }]} onConfirm={(v) => actM.mutateAsync(v)} />
  </div>;
}
