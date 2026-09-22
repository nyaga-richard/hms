'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/lib/query';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import { toast } from 'sonner';

export type FieldType = 'text' | 'number' | 'money' | 'email' | 'password' | 'date' | 'datetime' | 'time' | 'textarea' | 'select' | 'lookup' | 'switch' | 'multiselect' | 'tags' | 'json' | 'custom';
export interface Field { name: string; label: string; type?: FieldType; required?: boolean; placeholder?: string; options?: ({ value: string; label: string } | string)[]; source?: string; sourceLabel?: string | ((r: any) => string); sourceValue?: string; sourceQuery?: Record<string, any>; hint?: string; col?: 1 | 2 | 3 | 4 | 6; min?: number; max?: number; step?: number; default?: any; readOnly?: boolean; hidden?: (values: any) => boolean; render?: (props: { value: any; onChange: (v: any) => void; values: any }) => React.ReactNode; dependsOn?: string }
export function coerce(fields: Field[], values: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const f of fields) { if (f.hidden?.(values)) continue; let v = values[f.name]; if (v === '' || v === undefined) v = f.type === 'switch' ? false : null; else if (['number', 'money'].includes(f.type ?? '')) v = Number(v); else if (f.type === 'tags' && typeof v === 'string') v = v.split(',').map((s: string) => s.trim()).filter(Boolean); else if (f.type === 'json' && typeof v === 'string') { try { v = JSON.parse(v); } catch { throw new Error(`${f.label}: invalid JSON`); } } if (v === null && !f.required && f.type !== 'switch') { out[f.name] = null; continue; } out[f.name] = v; }
  return out;
}
export function LookupSelect({ source, value, onChange, label, sourceLabel, sourceValue = 'id', sourceQuery, placeholder, disabled, className, allowEmpty = true }: { source: string; value: any; onChange: (v: any, row?: any) => void; label?: string; sourceLabel?: string | ((r: any) => string); sourceValue?: string; sourceQuery?: Record<string, any>; placeholder?: string; disabled?: boolean; className?: string; allowEmpty?: boolean }) {
  const { data, isLoading } = useApi<any>(source, { pageSize: 500, ...(sourceQuery ?? {}) });
  const rows: any[] = data?.data ?? (Array.isArray(data) ? data : []);
  const lab = (r: any) => (typeof sourceLabel === 'function' ? sourceLabel(r) : sourceLabel ? r[sourceLabel] : r.name ?? r.full_name ?? r.number ?? r.code ?? r.title ?? r.id);
  return <NativeSelect value={value ?? ''} onChange={(e) => onChange(e.target.value || null, rows.find((r) => String(r[sourceValue]) === e.target.value))} disabled={disabled || isLoading} className={className} aria-label={label}>{allowEmpty && <option value="">{placeholder ?? (isLoading ? 'Loading…' : `Select ${label ?? ''}`)}</option>}{rows.map((r) => <option key={r[sourceValue]} value={r[sourceValue]}>{lab(r)}{r.code && !String(lab(r)).includes(r.code) && sourceLabel === undefined ? ` (${r.code})` : ''}</option>)}</NativeSelect>;
}
export function FieldControl({ f, value, onChange, values }: { f: Field; value: any; onChange: (v: any) => void; values: any }) {
  const common = { id: `f-${f.name}`, disabled: f.readOnly, placeholder: f.placeholder, required: f.required };
  switch (f.type) {
    case 'textarea': return <Textarea {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)} rows={3} />;
    case 'select': return <NativeSelect {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">{f.placeholder ?? 'Select…'}</option>{(f.options ?? []).map((o) => { const opt = typeof o === 'string' ? { value: o, label: o.replace(/_/g, ' ') } : o; return <option key={opt.value} value={opt.value}>{opt.label}</option>; })}</NativeSelect>;
    case 'lookup': return <LookupSelect source={f.source!} value={value} onChange={(v) => onChange(v)} label={f.label} sourceLabel={f.sourceLabel} sourceValue={f.sourceValue} sourceQuery={{ ...(f.sourceQuery ?? {}), ...(f.dependsOn ? { [f.dependsOn]: values[f.dependsOn] } : {}) }} placeholder={f.placeholder} disabled={f.readOnly} />;
    case 'switch': return <div className="flex h-9 items-center"><Switch id={common.id} checked={!!value} onCheckedChange={onChange} disabled={f.readOnly} /></div>;
    case 'multiselect': return <div className="flex flex-wrap gap-1.5 rounded-md border p-2 min-h-9">{(f.options ?? []).map((o) => { const opt = typeof o === 'string' ? { value: o, label: o.replace(/_/g, ' ') } : o; const arr: string[] = Array.isArray(value) ? value : []; const on = arr.includes(opt.value); return <button type="button" key={opt.value} onClick={() => onChange(on ? arr.filter((x) => x !== opt.value) : [...arr, opt.value])} className={cn('rounded-full border px-2 py-0.5 text-xs', on ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-accent')}>{opt.label}</button>; })}</div>;
    case 'tags': return <Input {...common} value={Array.isArray(value) ? value.join(', ') : value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder ?? 'comma, separated'} />;
    case 'json': return <Textarea {...common} className="font-mono text-xs" rows={4} value={typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)} onChange={(e) => onChange(e.target.value)} />;
    case 'custom': return <>{f.render?.({ value, onChange, values })}</>;
    case 'money': case 'number': return <Input {...common} type="number" inputMode="decimal" step={f.step ?? (f.type === 'money' ? '0.01' : 'any')} min={f.min} max={f.max} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="tabular" />;
    case 'datetime': return <Input {...common} type="datetime-local" value={value ? String(value).slice(0, 16) : ''} onChange={(e) => onChange(e.target.value)} />;
    default: return <Input {...common} type={f.type ?? 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} min={f.min} max={f.max} />;
  }
}
export function FormFields({ fields, values, setValues, cols = 2, errors }: { fields: Field[]; values: Record<string, any>; setValues: (fn: (v: Record<string, any>) => Record<string, any>) => void; cols?: 1 | 2 | 3 | 4; errors?: Record<string, string> }) {
  return <div className={cn('grid gap-3', { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' }[cols])}>
    {fields.filter((f) => !f.hidden?.(values)).map((f) => <div key={f.name} className={cn('flex flex-col gap-1', f.col === 2 && 'sm:col-span-2', f.col === 3 && 'sm:col-span-3', f.col === 4 && 'sm:col-span-4', (f.type === 'textarea' || f.type === 'json' || f.type === 'multiselect') && !f.col && cols > 1 && 'sm:col-span-2')}>
      <Label htmlFor={`f-${f.name}`}>{f.label}{f.required && <span className="text-destructive"> *</span>}</Label>
      <FieldControl f={f} value={values[f.name]} values={values} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
      {errors?.[f.name] ? <span className="text-[11px] text-destructive">{errors[f.name]}</span> : f.hint ? <span className="text-[11px] text-muted-foreground">{f.hint}</span> : null}
    </div>)}
  </div>;
}
export function useFormState(fields: Field[], initial?: Record<string, any> | null, open?: boolean) {
  const defaults = useMemo(() => Object.fromEntries(fields.map((f) => [f.name, f.default ?? (f.type === 'switch' ? false : '')])), [fields]);
  const [values, setValues] = useState<Record<string, any>>({ ...defaults, ...(initial ?? {}) });
  useEffect(() => { if (open !== false) setValues({ ...defaults, ...(initial ?? {}) }); }, [initial, open, defaults]);
  return { values, setValues, reset: () => setValues({ ...defaults }) };
}
export function errorsFrom(e: any): Record<string, string> { if (e instanceof ApiError && Array.isArray(e.details)) return Object.fromEntries(e.details.map((d: any) => [String(d.path).split('.').pop(), d.message])); return {}; }
/** Generic create/edit dialog driven by a field list. onSubmit receives coerced values. */
export function FormDialog({ open, onOpenChange, title, description, fields, initial, onSubmit, submitLabel = 'Save', cols = 2, size = 'md', children, extra }: { open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; fields: Field[]; initial?: Record<string, any> | null; onSubmit: (values: Record<string, any>, raw: Record<string, any>) => Promise<any>; submitLabel?: string; cols?: 1 | 2 | 3 | 4; size?: 'sm' | 'md' | 'lg' | 'xl'; children?: React.ReactNode; extra?: (ctx: { values: Record<string, any>; setValues: any }) => React.ReactNode }) {
  const { values, setValues } = useFormState(fields, initial, open);
  const [busy, setBusy] = useState(false); const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErrors({}); try { await onSubmit(coerce(fields, values), values); onOpenChange(false); } catch (err: any) { const fe = errorsFrom(err); setErrors(fe); if (!Object.keys(fe).length) toast.error(err.message ?? 'Failed'); else toast.error('Please fix the highlighted fields'); } finally { setBusy(false); } };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent size={size}><form onSubmit={submit} className="space-y-4"><DialogHeader><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>{children}<FormFields fields={fields} values={values} setValues={setValues} cols={cols} errors={errors} />{extra?.({ values, setValues })}<DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={busy}>{submitLabel}</Button></DialogFooter></form></DialogContent></Dialog>;
}
/** Confirm / reason dialog for state-changing actions (approve, reject, cancel, void…). */
export function ConfirmDialog({ open, onOpenChange, title, description, onConfirm, confirmLabel = 'Confirm', destructive, fields = [], children }: { open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; onConfirm: (values: Record<string, any>) => Promise<any>; confirmLabel?: string; destructive?: boolean; fields?: Field[]; children?: React.ReactNode }) {
  const { values, setValues } = useFormState(fields, null, open); const [busy, setBusy] = useState(false);
  const go = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); try { await onConfirm(coerce(fields, values)); onOpenChange(false); } catch (err: any) { toast.error(err.message ?? 'Failed', { description: Array.isArray(err.details) ? err.details.map((d: any) => `${d.path}: ${d.message}`).join(', ') : undefined }); } finally { setBusy(false); } };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent size="sm"><form onSubmit={go} className="space-y-4"><DialogHeader><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>{children}{fields.length > 0 && <FormFields fields={fields} values={values} setValues={setValues} cols={1} />}<DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" variant={destructive ? 'destructive' : 'default'} loading={busy}>{confirmLabel}</Button></DialogFooter></form></DialogContent></Dialog>;
}
/** Small hook to drive a ConfirmDialog/FormDialog imperatively: const d = useDialog(); d.open(payload) ... <ConfirmDialog open={d.isOpen} ... /> */
export function useDialog<T = any>() { const [state, setState] = useState<{ open: boolean; payload?: T }>({ open: false }); return { isOpen: state.open, payload: state.payload, open: (payload?: T) => setState({ open: true, payload }), close: () => setState({ open: false }), setOpen: (o: boolean) => setState((s) => ({ ...s, open: o })) }; }
