'use client';
import React, { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Plus, ChevronRight, ChevronDown, BookOpen } from 'lucide-react';
import { post, put } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { FormDialog, LookupSelect } from '@/components/shared/form';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { fmtDate, fmtMoney, fmtNum, titleCase, today, addDays } from '@/lib/utils';
import { JournalDetail } from '../journals/journals-view';

const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE'];
const acctFields = (parent?: string) => [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'type', label: 'Type', type: 'select' as const, options: TYPES, required: true }, { name: 'parent_id', label: 'Parent (header) account', type: 'lookup' as const, source: '/accounts', sourceQuery: { header: 'true', pageSize: 200 }, sourceLabel: (a: any) => `${a.code} · ${a.name}`, default: parent }, { name: 'is_header', label: 'Header (grouping) account', type: 'switch' as const }, { name: 'currency', label: 'Currency', default: 'KES' }, { name: 'description', label: 'Description', type: 'textarea' as const, col: 2 as const }, { name: 'is_active', label: 'Active', type: 'switch' as const, default: true }];
function Node({ n, depth, onLedger, onEdit, onAdd, currency }: { n: any; depth: number; onLedger: (a: any) => void; onEdit: (a: any) => void; onAdd: (a: any) => void; currency: string }) {
  const [open, setOpen] = useState(depth < 1); const kids = n.children ?? [];
  return <><div className="flex items-center gap-1 border-b py-1 text-sm hover:bg-accent/50" style={{ paddingLeft: depth * 18 + 4 }}>{kids.length > 0 ? <button type="button" onClick={() => setOpen(!open)} className="p-0.5">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button> : <span className="w-[18px]" />}<span className="w-16 font-mono text-xs text-muted-foreground">{n.code}</span><button type="button" className={`flex-1 text-left ${n.is_header ? 'font-semibold' : 'hover:underline'}`} onClick={() => (n.is_header ? setOpen(!open) : onLedger(n))}>{n.name}</button>{!n.is_active && <Badge tone="muted">inactive</Badge>}<span className={`w-32 text-right tabular ${n.is_header ? 'text-muted-foreground' : ''}`}>{fmtMoney(n.is_header ? n.total : n.balance, currency)}</span><div className="flex w-24 justify-end gap-0.5"><Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => onEdit(n)}>Edit</Button>{n.is_header && <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => onAdd(n)}>+</Button>}</div></div>{open && kids.map((k: any) => <Node key={k.id} n={k} depth={depth + 1} onLedger={onLedger} onEdit={onEdit} onAdd={onAdd} currency={currency} />)}</>;
}
function Ledger({ account, onClose }: { account: any | null; onClose: () => void }) {
  const { currency } = useAuth(); const [from, setFrom] = useState(today().slice(0, 8) + '01'); const [to, setTo] = useState(today()); const [je, setJe] = useState<string | null>(null);
  const { data } = useApi<any>(account ? `/accounts/${account.id}/ledger` : null, { from, to });
  if (!account) return null;
  return <Modal open={!!account} onOpenChange={(o) => !o && onClose()} title={`${account.code} · ${account.name}`} size="xl"><div className="space-y-3">
    <div className="flex items-end gap-2"><div className="flex flex-col gap-1"><Label>From</Label><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></div><div className="flex flex-col gap-1"><Label>To</Label><Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} /></div><KV cols={2} className="ml-auto" items={[['Opening', fmtMoney(data?.opening, currency)], ['Closing', fmtMoney(data?.closing, currency)]]} /></div>
    <div className="max-h-[55vh] overflow-auto rounded border"><table className="w-full text-sm"><thead className="sticky top-0 bg-muted text-xs uppercase text-muted-foreground"><tr><th className="p-2 text-left">Date</th><th className="p-2 text-left">Journal</th><th className="p-2 text-left">Source</th><th className="p-2 text-left">Description</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th><th className="p-2 text-right">Balance</th></tr></thead><tbody className="divide-y">{(data?.lines ?? []).map((l: any, i: number) => <tr key={i}><td className="p-2">{fmtDate(l.entry_date)}</td><td className="p-2"><button type="button" className="underline" onClick={() => setJe(l.journal_entry_id)}>{l.number}</button></td><td className="p-2 text-xs">{titleCase(l.source_type)}</td><td className="p-2">{l.description}</td><td className="p-2 text-right tabular">{Number(l.debit) ? fmtNum(l.debit, 2) : ''}</td><td className="p-2 text-right tabular">{Number(l.credit) ? fmtNum(l.credit, 2) : ''}</td><td className="p-2 text-right tabular">{fmtNum(l.balance, 2)}</td></tr>)}{(data?.lines ?? []).length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No postings in this period.</td></tr>}</tbody></table></div>
    <JournalDetail id={je} onClose={() => setJe(null)} />
  </div></Modal>;
}
function MappingsTab() {
  const { can } = useAuth(); const { data, refetch } = useApi<any[]>('/account-mappings'); const [edit, setEdit] = useState<any>(null); const [acct, setAcct] = useState('');
  const save = useAction(() => put(`/account-mappings/${edit.mapping_key}`, { account_id: acct, property_specific: true }), { success: 'Mapping updated', onSuccess: () => { setEdit(null); refetch(); } });
  const rows = data ?? [];
  return <Section title="Posting rules" description="Which GL account each automatic posting uses (room revenue, POS clearing, GRN accrual, tax…). Nothing is hard-coded — change the mapping and future journals follow."><table className="w-full text-sm"><thead className="text-xs uppercase text-muted-foreground"><tr><th className="text-left py-1">Mapping key</th><th className="text-left">Account</th><th className="text-left">Scope</th><th /></tr></thead><tbody className="divide-y">{rows.map((m: any) => <tr key={`${m.mapping_key}-${m.property_id ?? 'g'}`}><td className="py-1 font-mono text-xs">{m.mapping_key}</td><td>{m.account_code} · {m.account_name}</td><td className="text-xs">{m.property_id ? 'This property' : 'Global default'}</td><td className="text-right">{can('accounting.accounts') && <Button size="sm" variant="ghost" onClick={() => { setEdit(m); setAcct(m.account_id); }}>Change</Button>}</td></tr>)}</tbody></table>
    <Modal open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit ? `Map ${edit.mapping_key}` : ''} size="sm"><div className="space-y-3"><LookupSelect source="/accounts" sourceQuery={{ header: 'false', pageSize: 500 }} sourceLabel={(a: any) => `${a.code} · ${a.name}`} value={acct} onChange={setAcct} allowEmpty={false} /><div className="flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate(undefined as any)}>Save for this property</Button></div></div></Modal></Section>;
}
function AccountsInner() {
  const { can, currency } = useAuth(); const sp = useSearchParams(); const router = useRouter();
  const { data: tree, refetch } = useApi<any[]>('/accounts/tree'); const { data: flat } = useApi<any>('/accounts', { pageSize: 500 });
  const [ledger, setLedger] = useState<any>(null); const [dialog, setDialog] = useState<{ open: boolean; row?: any; parent?: string }>({ open: false }); const [filter, setFilter] = useState('');
  useEffect(() => { const id = sp.get('ledger'); if (id && flat?.data) { const a = flat.data.find((x: any) => x.id === id); if (a) setLedger(a); } }, [sp, flat]);
  const create = useAction((v: any) => (dialog.row ? put(`/accounts/${dialog.row.id}`, v) : post('/accounts', v)), { success: 'Saved', invalidate: ['/accounts'], onSuccess: () => { setDialog({ open: false }); refetch(); } });
  const roots = (tree ?? []).filter((r: any) => !filter || JSON.stringify(r).toLowerCase().includes(filter.toLowerCase()));
  return <div className="space-y-4">
    <PageHeader title="Chart of accounts" subtitle="Configurable account tree with live balances, drill-down ledgers and posting-rule mappings." actions={can('accounting.accounts') && <Button onClick={() => setDialog({ open: true })}><Plus />New account</Button>} />
    <Tabs defaultValue="tree"><TabsList><TabsTrigger value="tree">Accounts</TabsTrigger><TabsTrigger value="mappings">Posting rules</TabsTrigger></TabsList>
      <TabsContent value="tree"><div className="mb-2 flex gap-2"><Input className="w-72" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div><div className="rounded-lg border bg-card"><div className="flex items-center gap-1 border-b bg-muted/50 px-1 py-1 text-xs uppercase text-muted-foreground"><span className="w-[18px]" /><span className="w-16">Code</span><span className="flex-1">Account</span><span className="w-32 text-right">Balance</span><span className="w-24" /></div>{roots.map((n: any) => <Node key={n.id} n={n} depth={0} currency={currency} onLedger={setLedger} onEdit={(a) => setDialog({ open: true, row: a })} onAdd={(a) => setDialog({ open: true, parent: a.id })} />)}</div></TabsContent>
      <TabsContent value="mappings"><MappingsTab /></TabsContent>
    </Tabs>
    <FormDialog open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} title={dialog.row ? 'Edit account' : 'New account'} fields={acctFields(dialog.parent)} initial={dialog.row ?? (dialog.parent ? { parent_id: dialog.parent, type: (flat?.data ?? []).find((a: any) => a.id === dialog.parent)?.type } : undefined)} onSubmit={(v) => create.mutateAsync(v)} />
    <Ledger account={ledger} onClose={() => { setLedger(null); if (sp.get('ledger')) router.replace('/finance/accounts'); }} />
  </div>;
}
export default function AccountsPage() { return <Suspense fallback={null}><AccountsInner /></Suspense>; }
