'use client';
import React, { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, RefreshCw, Search, X } from 'lucide-react';
import { useApi } from '@/lib/query';
import { download } from '@/lib/api';
import { cn, fmtMoney, fmtDate, fmtDateTime, fmtNum } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/badge';
import { Empty, Spinner } from '@/components/ui/misc';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

export type ColType = 'text' | 'money' | 'number' | 'date' | 'datetime' | 'status' | 'bool' | 'boolean' | 'custom';
export interface Column<T = any> { key: string; label: string; type?: ColType; render?: (row: T) => React.ReactNode; className?: string; sortable?: boolean; hideOnMobile?: boolean; width?: string; decimals?: number }
export interface Filter { key: string; label: string; type?: 'select' | 'date' | 'text' | 'daterange'; options?: { value: string; label: string }[] | string[]; source?: string; sourceLabel?: string; sourceValue?: string; sourceQuery?: Record<string, any> }
export interface DataTableProps<T = any> { path: string; columns: Column<T>[]; filters?: Filter[]; query?: Record<string, any>; searchPlaceholder?: string; defaultSort?: string; defaultOrder?: 'asc' | 'desc'; onRowClick?: (row: T) => void; rowHref?: (row: T) => string; rowActions?: (row: T) => React.ReactNode; toolbar?: React.ReactNode; exportName?: string; pageSize?: number; dense?: boolean; emptyTitle?: string; emptyHint?: string; refreshKey?: any; selectable?: boolean; onSelection?: (rows: T[]) => void; footer?: (rows: T[]) => React.ReactNode; noSearch?: boolean; noExport?: boolean; rowClassName?: (row: T) => string }

export function CellValue({ value, type, decimals, currency }: { value: any; type?: ColType; decimals?: number; currency?: string }) {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>;
  switch (type) {
    case 'money': return <span className="tabular">{fmtMoney(value, currency)}</span>;
    case 'number': return <span className="tabular">{fmtNum(value, decimals ?? 2)}</span>;
    case 'date': return <>{fmtDate(value)}</>;
    case 'datetime': return <>{fmtDateTime(value)}</>;
    case 'status': return <StatusBadge status={String(value)} />;
    case 'bool': case 'boolean': return <span className={value ? 'text-emerald-600' : 'text-muted-foreground'}>{value ? 'Yes' : 'No'}</span>;
    default: return <>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</>;
  }
}
function FilterControl({ f, value, onChange }: { f: Filter; value: any; onChange: (v: any) => void }) {
  const { data } = useApi<any>(f.source ? f.source : null, { pageSize: 200, ...(f.sourceQuery ?? {}) });
  if (f.type === 'date') return <Input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="h-8 w-[150px]" aria-label={f.label} />;
  if (f.type === 'text') return <Input placeholder={f.label} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="h-8 w-[150px]" />;
  const opts = f.source ? ((data?.data ?? data ?? []) as any[]).map((r) => ({ value: String(r[f.sourceValue ?? 'id']), label: String(f.sourceLabel ? r[f.sourceLabel] : r.name ?? r.code ?? r.number ?? r.full_name) })) : (f.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o.replace(/_/g, ' ') } : o));
  return <NativeSelect value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="h-8 w-auto min-w-[130px]" aria-label={f.label}><option value="">{f.label}: All</option>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</NativeSelect>;
}
export function DataTable<T extends Record<string, any>>({ path, columns, filters = [], query = {}, searchPlaceholder = 'Search…', defaultSort, defaultOrder = 'desc', onRowClick, rowHref, rowActions, toolbar, exportName, pageSize = 25, dense, emptyTitle, emptyHint, refreshKey, selectable, onSelection, footer, noSearch, noExport, rowClassName }: DataTableProps<T>) {
  const router = useRouter(); const { can, currency } = useAuth();
  const [page, setPage] = useState(1); const [search, setSearch] = useState(''); const [debounced, setDebounced] = useState(''); const [sort, setSort] = useState(defaultSort); const [order, setOrder] = useState<'asc' | 'desc'>(defaultOrder);
  const [fv, setFv] = useState<Record<string, any>>({}); const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { const t = setTimeout(() => { setDebounced(search); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const q = useMemo(() => ({ ...query, ...fv, page, pageSize, search: debounced || undefined, sort, order }), [query, fv, page, pageSize, debounced, sort, order]);
  const { data, isLoading, isFetching, refetch, error } = useApi<any>(path, q);
  useEffect(() => { if (refreshKey !== undefined) refetch(); }, [refreshKey, refetch]);
  const rows: T[] = data?.data ?? (Array.isArray(data) ? data : []); const total = data?.total ?? rows.length; const pages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => { onSelection?.(rows.filter((r) => selected.has(r.id))); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleSort = (key: string) => { if (sort === key) setOrder(order === 'asc' ? 'desc' : 'asc'); else { setSort(key); setOrder('asc'); } };
  const doExport = async (format: 'csv' | 'xlsx' | 'pdf') => { try { await download(path, { ...query, ...fv, search: debounced || undefined, sort, order, format }, undefined); } catch (e: any) { toast.error(e.message); } };
  const activeFilters = Object.entries(fv).filter(([, v]) => v);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 no-print">
        {!noSearch && <div className="relative"><Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={searchPlaceholder} className="pl-8 h-8 w-[200px] sm:w-[240px]" /></div>}
        {filters.map((f) => <FilterControl key={f.key} f={f} value={fv[f.key]} onChange={(v) => { setFv((s) => ({ ...s, [f.key]: v })); setPage(1); }} />)}
        {activeFilters.length > 0 && <Button variant="ghost" size="sm" onClick={() => setFv({})}><X className="h-3.5 w-3.5" />Clear</Button>}
        <div className="ml-auto flex items-center gap-2">
          {toolbar}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetch()} aria-label="Refresh"><RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} /></Button>
          {!noExport && can('reports.export') && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /><span className="hidden sm:inline">Export</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => doExport('csv')}><FileText />CSV</DropdownMenuItem><DropdownMenuItem onClick={() => doExport('xlsx')}><FileSpreadsheet />Excel</DropdownMenuItem><DropdownMenuItem onClick={() => doExport('pdf')}><FileText />PDF</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
        </div>
      </div>
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {selectable && <th className="w-8 px-2"><input type="checkbox" aria-label="Select all" checked={rows.length > 0 && rows.every((r) => selected.has(r.id))} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>}
                {columns.map((c) => <th key={c.key} style={{ width: c.width }} className={cn('px-3 py-2 text-left font-medium whitespace-nowrap', c.hideOnMobile && 'hidden md:table-cell', (c.type === 'money' || c.type === 'number') && 'text-right', c.sortable !== false && 'cursor-pointer select-none hover:text-foreground')} onClick={() => c.sortable !== false && toggleSort(c.key)}><span className="inline-flex items-center gap-1">{c.label}{sort === c.key && (order === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</span></th>)}
                {rowActions && <th className="px-2 w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading ? <tr><td colSpan={columns.length + 2}><Spinner /></td></tr>
                : error ? <tr><td colSpan={columns.length + 2} className="p-6 text-center text-destructive text-sm">{(error as any).message}</td></tr>
                : rows.length === 0 ? <tr><td colSpan={columns.length + 2}><Empty title={emptyTitle} hint={emptyHint} /></td></tr>
                : rows.map((r, i) => {
                  const click = onRowClick ? () => onRowClick(r) : rowHref ? () => router.push(rowHref(r)) : undefined;
                  return <tr key={r.id ?? i} onClick={click} className={cn(click && 'cursor-pointer hover:bg-accent/40', selected.has(r.id) && 'bg-primary/5', rowClassName?.(r))}>
                    {selectable && <td className="px-2" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label="Select row" checked={selected.has(r.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(r.id) : n.delete(r.id); return n; })} /></td>}
                    {columns.map((c) => <td key={c.key} className={cn('px-3 align-middle', dense ? 'py-1' : 'py-2', c.hideOnMobile && 'hidden md:table-cell', (c.type === 'money' || c.type === 'number') && 'text-right', c.className)}>{c.render ? c.render(r) : <CellValue value={r[c.key]} type={c.type} decimals={c.decimals} currency={currency} />}</td>)}
                    {rowActions && <td className="px-2 text-right" onClick={(e) => e.stopPropagation()}>{rowActions(r)}</td>}
                  </tr>;
                })}
            </tbody>
            {footer && rows.length > 0 && <tfoot className="bg-muted/30 font-medium">{footer(rows)}</tfoot>}
          </table>
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>{total.toLocaleString()} record{total === 1 ? '' : 's'}{selected.size > 0 && ` · ${selected.size} selected`}</span>
          <div className="flex items-center gap-1"><Button variant="ghost" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button><span>Page {page} / {pages}</span><Button variant="ghost" size="icon" className="h-7 w-7" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button></div>
        </div>
      </div>
    </div>
  );
}
