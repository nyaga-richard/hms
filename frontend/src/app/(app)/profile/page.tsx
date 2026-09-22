'use client';
import React from 'react';
import { useAuth } from '@/lib/auth';
import { useApi, useAction } from '@/lib/query';
import { del } from '@/lib/api';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fmtDateTime } from '@/lib/utils';
export default function ProfilePage() {
  const { user } = useAuth(); const { data, refetch } = useApi<any>('/auth/sessions');
  const revoke = useAction((id: string) => del(`/auth/sessions/${id}`), { success: 'Session revoked', onSuccess: () => refetch() });
  const perms = [...(user?.permissions ?? [])].sort();
  return <div className="space-y-4"><PageHeader title="My profile" subtitle="Your roles, permissions and active sessions" />
    <Section title="Account"><KV cols={3} items={[{ label: 'Name', value: user?.full_name }, { label: 'Username', value: user?.username }, { label: 'Email', value: user?.email }, { label: 'Roles', value: (user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r.name)).join(', ') }, { label: 'Superuser', value: user?.is_superuser ? 'Yes' : 'No' }]} /></Section>
    <Section title={`Effective permissions (${perms.length})`}><div className="flex flex-wrap gap-1">{perms.map((p) => <Badge key={p} tone="muted">{p}</Badge>)}</div></Section>
    <Section title="Active sessions"><div className="divide-y text-sm">{(data?.data ?? data ?? []).map((s: any) => <div key={s.id} className="flex items-center justify-between py-2 gap-2"><div><div className="font-medium">{s.ip_address ?? 'unknown IP'} {s.current && <Badge tone="success">this device</Badge>}</div><div className="text-xs text-muted-foreground truncate max-w-md">{s.user_agent} · started {fmtDateTime(s.created_at)} · expires {fmtDateTime(s.expires_at)}</div></div>{!s.current && <Button size="sm" variant="outline" onClick={() => revoke.mutate(s.id)}>Revoke</Button>}</div>)}</div></Section>
  </div>;
}
