'use client';
import React from 'react';
import { DatabaseBackup, Download, Trash2, Server } from 'lucide-react';
import { post, del, download } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { fmtDateTime, fmtNum, titleCase } from '@/lib/utils';

const bytes = (n: any) => { const v = Number(n ?? 0); if (v > 1e9) return `${fmtNum(v / 1e9, 2)} GB`; if (v > 1e6) return `${fmtNum(v / 1e6, 1)} MB`; if (v > 1e3) return `${fmtNum(v / 1e3, 0)} KB`; return `${v} B`; };
export default function SystemPage() {
  const { can } = useAuth(); const { data: info } = useApi<any>('/system/info'); const { data: backups, refetch } = useApi<any>(can('settings.backup') ? '/backups' : null);
  const create = useAction(() => post('/backups', {}), { success: 'Backup created', onSuccess: () => refetch() }); const remove = useAction((id: string) => del(`/backups/${id}`), { success: 'Backup deleted', onSuccess: () => refetch() });
  return <div className="space-y-4">
    <PageHeader title="System & backups" subtitle="Runtime information and on-demand database backups. Scheduled backups run from the compose stack; both land in the same volume." crumbs={[{ label: 'Settings', href: '/settings' }, { label: 'System' }]} actions={can('settings.backup') && <Button loading={create.isPending} onClick={() => create.mutate(undefined as any)}><DatabaseBackup />Back up now</Button>} />
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Application"><KV cols={2} items={[['Name / version', `${info?.app?.name ?? ''} ${info?.app?.version ?? ''}`], ['Environment', info?.app?.env], ['Node', info?.app?.node], ['Uptime', info ? `${Math.floor(info.app.uptime_seconds / 3600)}h ${Math.floor((info.app.uptime_seconds % 3600) / 60)}m` : ''], ['Uploads path', <span key="u" className="break-all text-xs">{info?.storage?.uploads}</span>], ['Backups path', <span key="b" className="break-all text-xs">{info?.storage?.backups}</span>]]} /></Section>
      <Section title="Database"><KV cols={2} items={[['Server', <span key="v" className="text-xs">{info?.database?.version}</span>], ['Size', bytes(info?.database?.size)], ['Migrations applied', info?.database?.migrations], ['Latest migration', info?.database?.latest_migration]]} /></Section>
      <Section title="Record counts" className="lg:col-span-2"><div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">{Object.entries(info?.counts ?? {}).map(([k, v]) => <div key={k} className="rounded border p-2"><div className="text-xs text-muted-foreground">{titleCase(k)}</div><div className="text-lg font-semibold tabular">{fmtNum(v as any, 0)}</div></div>)}</div></Section>
      {can('settings.backup') && <Section title="Backups" className="lg:col-span-2" description={backups?.path ? `Stored under ${backups.path}` : undefined}><table className="w-full text-sm"><thead className="text-xs uppercase text-muted-foreground"><tr><th className="p-2 text-left">File</th><th className="p-2 text-left">Type</th><th className="p-2 text-right">Size</th><th className="p-2 text-left">Created</th><th className="p-2">Status</th><th /></tr></thead><tbody className="divide-y">{(backups?.data ?? []).map((b: any) => <tr key={b.id}><td className="p-2 font-mono text-xs">{b.file_name}</td><td className="p-2">{titleCase(b.type)}</td><td className="p-2 text-right tabular">{bytes(b.size_bytes)}</td><td className="p-2 text-xs">{fmtDateTime(b.created_at)} · {b.created_by_name}</td><td className="p-2 text-center"><StatusBadge status={b.status} />{b.verified && <Badge tone="success" className="ml-1">verified</Badge>}</td><td className="p-2 text-right whitespace-nowrap"><Button size="sm" variant="ghost" onClick={() => download(`/backups/${b.id}/download`, {}, b.file_name)}><Download /></Button><Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm('Delete this backup file?')) remove.mutate(b.id); }}><Trash2 /></Button></td></tr>)}{(backups?.data ?? []).length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground"><Server className="mx-auto mb-1 h-6 w-6" />No backups yet.</td></tr>}</tbody></table></Section>}
    </div>
  </div>;
}
