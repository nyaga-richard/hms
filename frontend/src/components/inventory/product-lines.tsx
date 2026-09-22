'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Search, Trash2 } from 'lucide-react';
import { get } from '@/lib/api';
import { useApi } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { fmtMoney, fmtNum } from '@/lib/utils';
const fmtNumber = (v: any) => fmtNum(v, 3);

export interface ProductLine { product_id: string; sku?: string; name: string; unit?: string; quantity: number | string; available?: number | null; avg_cost?: number | null; notes?: string; extra?: Record<string, any> }
/** Product search box: types SKU / name / barcode, lists matches (optionally with on-hand for a store), Enter picks the first match. Barcode scanners work as keyboards. */
export function ProductSearch({ onPick, storeId, placeholder = 'Search product by SKU, name or barcode…', stockOnly = true, autoFocus }: { onPick: (p: any) => void; storeId?: string | null; placeholder?: string; stockOnly?: boolean; autoFocus?: boolean }) {
  const [q, setQ] = useState(''); const [deb, setDeb] = useState(''); const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => setDeb(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  const { data } = useApi<any>(deb.length >= 1 ? '/products' : null, { search: deb, pageSize: 12, active: true, ...(stockOnly ? { stock_item: true } : {}) });
  const { data: stock } = useApi<any>(storeId && deb.length >= 1 ? '/stock' : null, { store_id: storeId, search: deb, pageSize: 50 });
  const onHand = (pid: string) => (stock?.data ?? []).find((s: any) => s.product_id === pid);
  useEffect(() => { const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const rows: any[] = data?.data ?? [];
  const pick = (p: any) => { const oh = onHand(p.id); onPick({ ...p, available: oh ? Number(oh.quantity) : null, avg_cost: oh ? Number(oh.avg_cost) : Number(p.cost_price) }); setQ(''); setOpen(false); };
  return <div ref={ref} className="relative"><div className="relative"><Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" /><Input autoFocus={autoFocus} className="pl-8" value={q} placeholder={placeholder} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const exact = rows.find((r) => r.barcode === q.trim() || r.sku === q.trim()); if (exact || rows[0]) pick(exact ?? rows[0]); } }} /></div>
    {open && deb && <div className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-md">{rows.length === 0 && <div className="p-3 text-sm text-muted-foreground">No products match “{deb}”.</div>}{rows.map((p) => { const oh = onHand(p.id); return <button type="button" key={p.id} onClick={() => pick(p)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"><span><span className="font-medium">{p.name}</span> <span className="text-xs text-muted-foreground">{p.sku} · {p.unit}</span></span>{storeId && <span className={`text-xs tabular ${oh && Number(oh.quantity) <= 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{oh ? `${fmtNumber(oh.quantity)} ${p.unit}` : '0'}</span>}</button>; })}</div>}</div>;
}
/** Editable line table for stock documents (requisition / transfer / issue / adjustment). */
export function ProductLines({ lines, onChange, storeId, qtyLabel = 'Quantity', showAvailable = true, showCost = false, extraColumn, stockOnly = true, allowNotes }: { lines: ProductLine[]; onChange: (l: ProductLine[]) => void; storeId?: string | null; qtyLabel?: string; showAvailable?: boolean; showCost?: boolean; extraColumn?: { label: string; render: (l: ProductLine, set: (patch: Partial<ProductLine>) => void) => React.ReactNode }; stockOnly?: boolean; allowNotes?: boolean }) {
  const { currency } = useAuth();
  const add = (p: any) => { if (lines.some((l) => l.product_id === p.id)) return onChange(lines.map((l) => (l.product_id === p.id ? { ...l, quantity: Number(l.quantity || 0) + 1 } : l))); onChange([...lines, { product_id: p.id, sku: p.sku, name: p.name, unit: p.unit, quantity: 1, available: p.available, avg_cost: p.avg_cost }]); };
  const setAt = (i: number, patch: Partial<ProductLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.avg_cost || 0), 0);
  return <div className="space-y-2"><ProductSearch onPick={add} storeId={storeId} stockOnly={stockOnly} />
    <div className="rounded-md border overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr><th className="p-2 text-left">Product</th>{showAvailable && storeId && <th className="p-2 text-right">On hand</th>}<th className="p-2 text-right w-32">{qtyLabel}</th>{extraColumn && <th className="p-2 text-right w-36">{extraColumn.label}</th>}{showCost && <th className="p-2 text-right">Est. value</th>}{allowNotes && <th className="p-2 text-left">Notes</th>}<th className="w-8" /></tr></thead>
      <tbody className="divide-y">{lines.map((l, i) => <tr key={l.product_id}><td className="p-2"><div className="font-medium">{l.name}</div><div className="text-xs text-muted-foreground">{l.sku} · {l.unit}</div></td>{showAvailable && storeId && <td className={`p-2 text-right tabular ${l.available != null && Number(l.quantity) > Number(l.available) ? 'text-destructive font-medium' : ''}`}>{l.available == null ? '—' : fmtNumber(l.available)}</td>}<td className="p-2"><Input type="number" step="any" min={0} className="text-right" value={l.quantity} onChange={(e) => setAt(i, { quantity: e.target.value })} /></td>{extraColumn && <td className="p-2">{extraColumn.render(l, (patch) => setAt(i, patch))}</td>}{showCost && <td className="p-2 text-right tabular">{fmtMoney(Number(l.quantity || 0) * Number(l.avg_cost || 0), currency)}</td>}{allowNotes && <td className="p-2"><Input value={l.notes ?? ''} onChange={(e) => setAt(i, { notes: e.target.value })} placeholder="Optional" /></td>}<td className="p-1"><Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button></td></tr>)}{lines.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-sm text-muted-foreground">Search above to add products. Scan barcodes directly into the search box.</td></tr>}</tbody>
      {showCost && lines.length > 0 && <tfoot><tr className="font-semibold"><td className="p-2" colSpan={showAvailable && storeId ? 3 : 2}>Estimated value</td><td className="p-2 text-right tabular" colSpan={extraColumn ? 2 : 1}>{fmtMoney(total, currency)}</td>{allowNotes && <td />}<td /></tr></tfoot>}</table></div></div>;
}
/** Read-only lines table used on document detail screens. */
export function LinesTable({ rows, columns }: { rows: any[]; columns: { key: string; label: string; align?: 'left' | 'right'; render?: (r: any) => React.ReactNode }[] }) {
  return <div className="rounded-md border overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50 text-xs uppercase text-muted-foreground"><tr>{columns.map((c) => <th key={c.key} className={`p-2 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>)}</tr></thead><tbody className="divide-y">{rows.map((r, i) => <tr key={r.id ?? i}>{columns.map((c) => <td key={c.key} className={`p-2 ${c.align === 'right' ? 'text-right tabular' : ''}`}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}</tr>)}{rows.length === 0 && <tr><td colSpan={columns.length} className="p-4 text-center text-muted-foreground">No lines.</td></tr>}</tbody></table></div>;
}
