'use client';
import React from 'react';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Section } from './page';
import { StatusBadge } from '@/components/ui/badge';
import { fmtDateTime } from '@/lib/utils';
/** Renders a workflow approval request (steps + actions) attached to a document. */
export function ApprovalTrail({ approval, title = 'Approval' }: { approval: any | null | undefined; title?: string }) {
  if (!approval) return null;
  const actions: any[] = approval.actions ?? [];
  return <Section title={<span className="flex items-center gap-2">{title} <StatusBadge status={approval.status} /></span>}>
    <div className="text-xs text-muted-foreground mb-2">{approval.workflow_name ?? approval.entity_type} · step {approval.current_step ?? '—'}{approval.amount ? ` · amount ${approval.amount}` : ''}</div>
    {actions.length === 0 ? <p className="text-sm text-muted-foreground">Awaiting first approver.</p> : <ol className="space-y-1 text-sm">{actions.map((a, i) => <li key={i} className="flex items-start gap-2">{a.action === 'APPROVE' ? <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" /> : a.action === 'REJECT' ? <XCircle className="h-4 w-4 text-red-600 mt-0.5" /> : <Clock className="h-4 w-4 text-amber-600 mt-0.5" />}<div><b>{a.name ?? `Step ${a.step}`}</b> — {a.action?.toLowerCase()} by {a.actor ?? '—'} <span className="text-xs text-muted-foreground">{fmtDateTime(a.at)}</span>{a.comment && <div className="text-muted-foreground">{a.comment}</div>}</div></li>)}</ol>}
  </Section>;
}
