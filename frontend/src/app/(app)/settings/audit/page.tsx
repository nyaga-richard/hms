'use client';
import React, { useState } from 'react';
import { PageHeader } from '@/components/shared/page';
import { DataTable } from '@/components/shared/data-table';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { KV } from '@/components/shared/page';
import { fmtDateTime, titleCase } from '@/lib/utils';

const ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'APPROVE', 'REJECT', 'POST', 'REVERSE', 'VOID', 'CANCEL', 'CHECK_IN', 'CHECK_OUT', 'PAYMENT', 'REFUND', 'EXPORT', 'IMPORT', 'SETTINGS', 'PASSWORD_RESET', 'NIGHT_AUDIT'];
const TONE: Record<string, any> = { CREATE: 'success', UPDATE: 'info', DELETE: 'destructive', VOID: 'destructive', REVERSE: 'warning', LOGIN_FAILED: 'destructive', APPROVE: 'success', REJECT: 'destructive' };
function Diff({ a, b }: { a: any; b: any }) {
  const keys = Array.from(new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])).filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
  if (!keys.length) return <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(b ?? a, null, 2)}</pre>;
  return <table className="w-full text-xs"><thead className="uppercase text-muted-foreground"><tr><th className="p-1 text-left">Field</th><th className="p-1 text-left">Before</th><th className="p-1 text-left">After</th></tr></thead><tbody className="divide-y">{keys.map((k) => <tr key={k}><td className="p-1 font-mono">{k}</td><td className="p-1 text-destructive/80 break-all">{a?.[k] === undefined ? '' : typeof a[k] === 'object' ? JSON.stringify(a[k]) : String(a[k])}</td><td className="p-1 text-emerald-700 break-all">{b?.[k] === undefined ? '' : typeof b[k] === 'object' ? JSON.stringify(b[k]) : String(b[k])}</td></tr>)}</tbody></table>;
}
export default function AuditPage() {
  const [sel, setSel] = useState<any>(null);
  return <div className="space-y-4">
    <PageHeader title="Audit trail" subtitle="Immutable log of every create, update, approval, posting, reversal, login and export — with before/after values." crumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Audit' }]} />
    <DataTable path="/audit" defaultSort="created_at" onRowClick={setSel} exportName="audit" searchPlaceholder="Search entity id, username, reason…" filters={[{ key: 'action', label: 'Action', type: 'select', options: ACTIONS }, { key: 'entity', label: 'Entity type', type: 'text' }, { key: 'user', label: 'User', type: 'text' }, { key: 'date', label: 'Date', type: 'daterange' }]}
      columns={[{ key: 'created_at', label: 'When', type: 'datetime' }, { key: 'username', label: 'User' }, { key: 'action', label: 'Action', render: (r) => <Badge tone={TONE[r.action] ?? 'muted'}>{titleCase(r.action)}</Badge> }, { key: 'entity_type', label: 'Entity', render: (r) => titleCase(r.entity_type) }, { key: 'entity_id', label: 'Record', render: (r) => <span className="font-mono text-xs">{String(r.entity_id ?? '').slice(0, 8)}</span> }, { key: 'reason', label: 'Reason', hideOnMobile: true }, { key: 'ip_address', label: 'IP', hideOnMobile: true }]} />
    <Modal open={!!sel} onOpenChange={(o) => !o && setSel(null)} title={sel ? `${titleCase(sel.action)} · ${titleCase(sel.entity_type)}` : ''} size="lg">{sel && <div className="space-y-3"><KV cols={3} items={[['When', fmtDateTime(sel.created_at)], ['User', sel.username], ['Record', <span key="r" className="font-mono text-xs">{sel.entity_id}</span>], ['IP', sel.ip_address ?? '—'], ['Agent', <span key="ua" className="text-xs">{sel.user_agent ?? '—'}</span>], ['Reason', sel.reason ?? '—']]} /><Diff a={sel.old_value} b={sel.new_value} /></div>}</Modal>
  </div>;
}
