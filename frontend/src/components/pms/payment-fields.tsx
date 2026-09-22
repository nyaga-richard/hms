'use client';
import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useApi } from '@/lib/query';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { fmtMoney } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
export interface PaymentLine { payment_method_id?: string; payment_method_code?: string; amount: number | string; reference?: string; cashier_shift_id?: string | null }
/** Reusable payment-method picker + amount (+ reference when the method requires it). Knows the cashier's open shift. */
export function usePaymentMethods() { const { data } = useApi<any>('/payment-methods', { pageSize: 100 }); return ((data?.data ?? []) as any[]).filter((m) => m.is_active !== false); }
export function useMyOpenShift() { const { data } = useApi<any>('/shifts/current'); return data?.shift ?? data ?? null; }
export function PaymentLineFields({ value, onChange, showAmount = true, methods: methodsProp }: { value: PaymentLine; onChange: (v: PaymentLine) => void; showAmount?: boolean; methods?: any[] }) {
  const fetched = usePaymentMethods(); const methods = methodsProp ?? fetched; const m = methods.find((x) => x.id === value.payment_method_id);
  return <div className="grid grid-cols-2 gap-2">
    <div className="flex flex-col gap-1"><Label>Method</Label><NativeSelect value={value.payment_method_id ?? ''} onChange={(e) => onChange({ ...value, payment_method_id: e.target.value || undefined })}><option value="">Select…</option>{methods.map((pm) => <option key={pm.id} value={pm.id}>{pm.name}</option>)}</NativeSelect></div>
    {showAmount && <div className="flex flex-col gap-1"><Label>Amount</Label><Input type="number" inputMode="decimal" step="0.01" min={0} value={value.amount} onChange={(e) => onChange({ ...value, amount: e.target.value })} className="tabular" /></div>}
    {(m?.requires_reference || m?.type === 'CARD' || m?.type === 'MOBILE_MONEY' || m?.type === 'BANK_TRANSFER' || m?.type === 'CHEQUE') && <div className="flex flex-col gap-1 col-span-2"><Label>Reference {m?.requires_reference && <span className="text-destructive">*</span>}</Label><Input value={value.reference ?? ''} onChange={(e) => onChange({ ...value, reference: e.target.value })} placeholder="Transaction / card / cheque ref" required={!!m?.requires_reference} /></div>}
  </div>;
}
export function PaymentsEditor({ lines, onChange, due }: { lines: PaymentLine[]; onChange: (l: PaymentLine[]) => void; due?: number }) {
  const { currency } = useAuth(); const methods = usePaymentMethods(); const paid = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  return <div className="space-y-2">
    {lines.map((l, i) => <div key={i} className="rounded-md border p-2 relative"><PaymentLineFields value={l} onChange={(v) => onChange(lines.map((x, j) => (j === i ? v : x)))} methods={methods} />{lines.length > 1 && <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1 h-6 w-6" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>}</div>)}
    <div className="flex items-center justify-between text-sm"><Button type="button" variant="outline" size="sm" onClick={() => onChange([...lines, { amount: Math.max(0, (due ?? 0) - paid) }])}><Plus className="h-3.5 w-3.5" />Split payment</Button>{due !== undefined && <span className={paid + 0.005 >= due ? 'text-emerald-600' : 'text-muted-foreground'}>Paid {fmtMoney(paid, currency)} of {fmtMoney(due, currency)}{paid > due + 0.005 && <span className="text-amber-600"> · change {fmtMoney(paid - due, currency)}</span>}</span>}</div>
  </div>;
}
