'use client';
import React, { useState } from 'react';
import { History } from 'lucide-react';
import { useApi } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { Section } from './page';
import { Badge } from '@/components/ui/badge';
import { fmtDateTime, titleCase } from '@/lib/utils';
/** Audit log for a single entity; only rendered for users with audit.view. */
export function AuditTrail({ entity, entityId, title = 'Audit trail' }: { entity: string; entityId: string; title?: string }) {
  const { can } = useAuth(); const [open, setOpen] = useState<string | null>(null);
  const { data } = useApi<any>('/audit', { entityType: entity, entityId, pageSize: 50 }, { enabled: can('audit.view') });
  if (!can('audit.view')) return null;
  const rows: any[] = data?.data ?? [];
  return <Section title={<span className="flex items-center gap-2"><History className="h-4 w-4" />{title}</span>}>
    {rows.length === 0 ? <p className="text-sm text-muted-foreground">No audit entries.</p> : <ul className="divide-y text-sm max-h-80 overflow-y-auto">{rows.map((a) => <li key={a.id} className="py-1.5"><button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen(open === a.id ? null : a.id)}><span><Badge tone="muted" className="mr-2">{titleCase(a.action)}</Badge>{a.username ?? 'system'}{a.reason && <span className="text-muted-foreground"> — {a.reason}</span>}</span><span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(a.created_at)}</span></button>{open === a.id && <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify({ old: a.old_value, new: a.new_value, ip: a.ip_address }, null, 1)}</pre>}</li>)}</ul>}
  </Section>;
}
