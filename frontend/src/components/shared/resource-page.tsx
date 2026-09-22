'use client';
import React, { useState } from 'react';
import { Plus, Pencil, Trash2, MoreHorizontal } from 'lucide-react';
import { PageHeader } from './page';
import { DataTable, type Column, type Filter } from './data-table';
import { FormDialog, ConfirmDialog, type Field } from './form';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { post, put, del } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useInvalidate } from '@/lib/query';
import { toast } from 'sonner';

export interface ResourcePageProps { title: string; subtitle?: string; path: string; searchPlaceholder?: string; entity?: string; columns: Column[]; fields: Field[]; editFields?: Field[]; filters?: Filter[]; permissions: { view?: string; create?: string; edit?: string; delete?: string }; query?: Record<string, any>; defaultSort?: string; rowHref?: (r: any) => string; extraActions?: (row: any, reload: () => void) => React.ReactNode; headerActions?: React.ReactNode; canEditRow?: (r: any) => boolean; canDeleteRow?: (r: any) => boolean; deleteLabel?: string; transformIn?: (r: any) => any; transformOut?: (v: any, editing: boolean) => any; crumbs?: { label: string; href?: string }[]; cols?: 1 | 2 | 3 | 4; dialogSize?: 'sm' | 'md' | 'lg' | 'xl'; softDelete?: boolean; embedded?: boolean; children?: React.ReactNode }
export function ResourcePage(p: ResourcePageProps) {
  const { can } = useAuth(); const invalidate = useInvalidate();
  const [dialog, setDialog] = useState<{ open: boolean; row?: any }>({ open: false }); const [delRow, setDelRow] = useState<any>(null); const [tick, setTick] = useState(0);
  const reload = () => { invalidate(p.path); setTick((t) => t + 1); };
  const entity = p.entity ?? p.title.replace(/s$/, '');
  const canCreate = !p.permissions.create || can(p.permissions.create); const canEdit = !p.permissions.edit || can(p.permissions.edit); const canDelete = !!p.permissions.delete && can(p.permissions.delete);
  return <div>
    {p.embedded ? <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-base font-semibold">{p.title}</h2>{p.subtitle && <p className="text-xs text-muted-foreground">{p.subtitle}</p>}</div><div className="flex gap-2">{p.headerActions}{canCreate && <Button size="sm" onClick={() => setDialog({ open: true })}><Plus />New {entity}</Button>}</div></div>
      : <PageHeader title={p.title} subtitle={p.subtitle} crumbs={p.crumbs} actions={<>{p.headerActions}{canCreate && <Button onClick={() => setDialog({ open: true })}><Plus />New {entity}</Button>}</>} />}
    {p.children}
    <DataTable path={p.path} columns={p.columns} filters={p.filters} query={p.query} defaultSort={p.defaultSort} searchPlaceholder={p.searchPlaceholder} rowHref={p.rowHref} refreshKey={tick} onRowClick={!p.rowHref && canEdit ? (r) => setDialog({ open: true, row: r }) : undefined}
      rowActions={(row) => (canEdit || canDelete || p.extraActions) ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Actions"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
        {canEdit && (p.canEditRow?.(row) ?? true) && <DropdownMenuItem onClick={() => setDialog({ open: true, row })}><Pencil />Edit</DropdownMenuItem>}
        {p.extraActions?.(row, reload)}
        {canDelete && (p.canDeleteRow?.(row) ?? true) && <DropdownMenuItem destructive onClick={() => setDelRow(row)}><Trash2 />{p.deleteLabel ?? (p.softDelete ? 'Deactivate' : 'Delete')}</DropdownMenuItem>}
      </DropdownMenuContent></DropdownMenu> : null} />
    <FormDialog open={dialog.open} onOpenChange={(o) => setDialog((s) => ({ ...s, open: o }))} title={dialog.row ? `Edit ${entity}` : `New ${entity}`} fields={dialog.row && p.editFields ? p.editFields : p.fields} initial={dialog.row ? (p.transformIn ? p.transformIn(dialog.row) : dialog.row) : null} cols={p.cols} size={p.dialogSize}
      onSubmit={async (v) => { const body = p.transformOut ? p.transformOut(v, !!dialog.row) : v; if (dialog.row) await put(`${p.path}/${dialog.row.id}`, body); else await post(p.path, body); toast.success(dialog.row ? `${entity} updated` : `${entity} created`); reload(); }} />
    <ConfirmDialog open={!!delRow} onOpenChange={(o) => !o && setDelRow(null)} title={`${p.deleteLabel ?? (p.softDelete ? 'Deactivate' : 'Delete')} ${entity}?`} description={delRow?.name ?? delRow?.code ?? delRow?.number} destructive confirmLabel={p.deleteLabel ?? (p.softDelete ? 'Deactivate' : 'Delete')} onConfirm={async () => { await del(`${p.path}/${delRow.id}`); toast.success('Done'); reload(); }} />
  </div>;
}
