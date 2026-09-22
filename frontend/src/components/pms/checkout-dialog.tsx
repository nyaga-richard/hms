'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, LogOut } from 'lucide-react';
import { post } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { Modal } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/misc';
import { Spinner } from '@/components/ui/misc';
import { fmtDate, fmtMoney } from '@/lib/utils';
import { PaymentsEditor, type PaymentLine } from './payment-fields';

/** Checkout: preview → settle outstanding balance → confirm. Uses GET /checkouts/:stayId/preview so pending nights are shown before posting. */
export function CheckOutDialog({ stay, onOpenChange, onDone }: { stay: any | null; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  const router = useRouter(); const { currency, can } = useAuth(); const open = !!stay;
  const { data: prev, isLoading } = useApi<any>(`/checkouts/${stay?.id}/preview`, undefined, { enabled: open });
  const [payments, setPayments] = useState<PaymentLine[]>([{ amount: '' }]); const [lateFee, setLateFee] = useState(''); const [allowBalance, setAllowBalance] = useState(false); const [notes, setNotes] = useState(''); const [postTonight, setPostTonight] = useState(false);
  const due = Math.max(0, Number(prev?.projected_balance ?? 0) + Number(lateFee || 0)); const refundDue = Math.max(0, -(Number(prev?.projected_balance ?? 0) + Number(lateFee || 0)));
  useEffect(() => { if (prev) { setPayments([{ amount: due > 0 ? due.toFixed(2) : '' }]); } }, [prev?.projected_balance]); // eslint-disable-line
  const run = useAction(() => post('/checkouts', { stay_id: stay.id, payments: payments.filter((p) => Number(p.amount) > 0 && p.payment_method_id), refund: refundDue > 0 && payments[0]?.payment_method_id ? { ...payments[0], amount: refundDue } : null, late_checkout_fee: lateFee ? Number(lateFee) : undefined, allow_balance: allowBalance || undefined, notes: notes || undefined, post_tonight_room_charge: postTonight || undefined }), { success: 'Checked out — room sent to housekeeping', invalidate: ['/stays', '/rooms', '/folios', '/dashboard', '/housekeeping'], onSuccess: (r: any) => { onOpenChange(false); onDone?.(); if (r?.invoice?.id) router.push(`/front-office/folios/${prev?.folio?.id ?? stay.folio_id}`); } });
  const open_orders: any[] = prev?.open_orders ?? [];
  return <Modal open={open} onOpenChange={onOpenChange} title={`Check out · Room ${stay?.room_number} · ${stay?.guest_name}`} size="lg">
    {isLoading || !prev ? <Spinner /> : <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Folio balance</div><div className="text-lg font-semibold tabular">{fmtMoney(prev.folio?.totals?.balance, currency)}</div></div>
        <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Un-posted nights</div><div className="text-lg font-semibold tabular">{prev.pending_nights?.length ?? 0} <span className="text-xs font-normal">({fmtMoney((prev.pending_nights?.length ?? 0) * Number(stay?.rate ?? 0), currency)})</span></div></div>
        <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Projected balance</div><div className={`text-lg font-semibold tabular ${Number(prev.projected_balance) > 0 ? 'text-destructive' : 'text-emerald-600'}`}>{fmtMoney(prev.projected_balance, currency)}</div></div>
        <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">Due out</div><div className="text-lg font-semibold">{fmtDate(stay?.expected_check_out)}</div></div>
      </div>
      {open_orders.length > 0 && <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm flex gap-2"><AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5" /><div><b>{open_orders.length} open outlet order(s)</b> must be settled or posted to the room before checkout: {open_orders.map((o: any) => `${o.number ?? o.id.slice(0, 8)} (${o.outlet_name ?? ''} ${fmtMoney(o.total, currency)})`).join(', ')}</div></div>}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1"><Label>Late checkout fee</Label><Input type="number" step="0.01" min={0} value={lateFee} onChange={(e) => setLateFee(e.target.value)} placeholder="0.00" /></div>
        <label className="flex items-center gap-2 text-sm pt-6"><Switch checked={postTonight} onCheckedChange={setPostTonight} /> Post tonight&apos;s room charge (early departure with charge)</label>
      </div>
      {due > 0 && <div><div className="text-sm font-medium mb-1">Settle balance</div><PaymentsEditor lines={payments} onChange={setPayments} due={due} /></div>}
      {refundDue > 0 && <div><div className="text-sm font-medium mb-1 text-emerald-700">Refund due to guest: {fmtMoney(refundDue, currency)}</div><PaymentsEditor lines={payments} onChange={setPayments} /></div>}
      {due > 0 && can('receivables.manage') && <label className="flex items-center gap-2 text-sm"><Switch checked={allowBalance} onCheckedChange={setAllowBalance} /> Check out with outstanding balance {stay?.customer_name ? `(bill to ${stay.customer_name})` : '(transfer to receivables)'}</label>}
      <div className="flex flex-col gap-1"><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => router.push(`/front-office/folios/${prev.folio?.id ?? stay.folio_id}`)}>Open folio</Button><Button loading={run.isPending} disabled={open_orders.length > 0} onClick={() => run.mutate(undefined as any)}><LogOut />Confirm checkout</Button></div>
    </div>}
  </Modal>;
}
