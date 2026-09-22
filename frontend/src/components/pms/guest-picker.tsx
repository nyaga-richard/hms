'use client';
import React, { useEffect, useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import { get, post } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FormDialog, type Field } from '@/components/shared/form';
export const GUEST_FIELDS: Field[] = [
  { name: 'title', label: 'Title', type: 'select', options: ['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Hon'] }, { name: 'first_name', label: 'First name', required: true }, { name: 'last_name', label: 'Last name', required: true }, { name: 'gender', label: 'Gender', type: 'select', options: ['MALE', 'FEMALE', 'OTHER'] },
  { name: 'phone', label: 'Phone', type: 'text' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'nationality', label: 'Nationality' }, { name: 'date_of_birth', label: 'Date of birth', type: 'date' },
  { name: 'id_type', label: 'ID type', type: 'select', options: ['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE', 'OTHER'] }, { name: 'id_number', label: 'ID number' }, { name: 'company_name', label: 'Company' }, { name: 'customer_id', label: 'Corporate account', type: 'lookup', source: '/customers' },
  { name: 'vip_level', label: 'VIP level', type: 'number', min: 0, max: 5, default: 0 }, { name: 'address', label: 'Address', col: 2 }, { name: 'preferences', label: 'Preferences / notes', type: 'textarea' },
];
/** Type-ahead guest search with inline "create guest" — used by reservation & walk-in wizards. */
export function GuestPicker({ value, onChange }: { value: any | null; onChange: (g: any | null) => void }) {
  const [q, setQ] = useState(''); const [rows, setRows] = useState<any[]>([]); const [open, setOpen] = useState(false); const [create, setCreate] = useState(false);
  useEffect(() => { if (q.trim().length < 2) { setRows([]); return; } const t = setTimeout(() => get('/guests', { search: q, pageSize: 8 }).then((r) => { setRows(r.data ?? []); setOpen(true); }).catch(() => {}), 250); return () => clearTimeout(t); }, [q]);
  if (value) return <div className="flex items-center justify-between rounded-md border p-3"><div><div className="font-medium">{value.full_name ?? `${value.first_name} ${value.last_name}`} {value.vip_level > 0 && <Badge tone="warning">VIP {value.vip_level}</Badge>} {value.is_blacklisted && <Badge tone="destructive">Blacklisted</Badge>}</div><div className="text-xs text-muted-foreground">{[value.guest_no, value.phone, value.email, value.nationality].filter(Boolean).join(' · ')}{value.stay_count ? ` · ${value.stay_count} previous stay(s)` : ''}</div></div><Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>Change</Button></div>;
  return <div className="relative">
    <div className="flex gap-2"><div className="relative flex-1"><Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => rows.length && setOpen(true)} placeholder="Search guest by name, phone, ID or email…" className="pl-8" autoFocus /></div><Button type="button" variant="outline" onClick={() => setCreate(true)}><UserPlus className="h-4 w-4" />New guest</Button></div>
    {open && rows.length > 0 && <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md max-h-64 overflow-y-auto">{rows.map((g) => <button type="button" key={g.id} onClick={() => { onChange(g); setOpen(false); setQ(''); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"><div><div className="font-medium">{g.full_name} {g.vip_level > 0 && <Badge tone="warning">VIP</Badge>}</div><div className="text-xs text-muted-foreground">{[g.phone, g.email, g.id_number].filter(Boolean).join(' · ')}</div></div><span className="text-xs text-muted-foreground">{g.stay_count ?? 0} stays</span></button>)}</div>}
    {open && q.length >= 2 && rows.length === 0 && <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">No guest found — <button type="button" className="text-primary underline" onClick={() => setCreate(true)}>create a new profile</button></div>}
    <FormDialog open={create} onOpenChange={setCreate} title="New guest profile" fields={GUEST_FIELDS} size="lg" onSubmit={async (v) => { const g = await post('/guests', v); onChange({ ...g, full_name: `${g.first_name} ${g.last_name}` }); }} />
  </div>;
}
