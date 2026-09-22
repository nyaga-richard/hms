'use client';
import React, { useMemo, useState } from 'react';
import { Send, Wallet, Trash2, Percent, ArrowRightLeft, Split, Printer, Ban, Plus, Minus, Receipt } from 'lucide-react';
import { post, get } from '@/lib/api';
import { useApi, useAction } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Spinner, Checkbox } from '@/components/ui/misc';
import { Modal } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { ConfirmDialog, FormDialog, LookupSelect } from '@/components/shared/form';
import { fmtMoney, fmtTime, cn, titleCase } from '@/lib/utils';
import { usePaymentMethods } from '@/components/pms/payment-fields';
import { PrintButton, usePrinter, ReceiptDoc, KitchenTicketsDoc, type KotTicket } from '@/lib/print';

type Line = { menu_item_id: string; name: string; price: number; quantity: number; modifiers: any[]; special_instructions?: string; course?: number | null };
/** Right-hand order panel of the POS: pending (unsent) lines, sent items with kitchen status, totals, and settle/discount/transfer/split actions. */
export function OrderPanel({ orderId, outlet, pending, setPending, onClosed, onOrderCreated, newOrderMeta }: { orderId: string | null; outlet: any; pending: Line[]; setPending: (l: Line[]) => void; onClosed: () => void; onOrderCreated: (o: any) => void; newOrderMeta: { type: string; table_id?: string | null; covers?: number; stay_id?: string | null; notes?: string } }) {
  const { can, currency } = useAuth();
  const { print: printDoc, profile: printProfile } = usePrinter();
  const { data: order, refetch } = useApi<any>(orderId ? `/orders/${orderId}` : null, undefined, { refetchInterval: 15000 });
  /** Kitchen/bar tickets created by a send: print them (one page per ticket) when the hotel enabled it. */
  const printNewTickets = async (before: any, after: any) => {
    if (!printProfile?.settings?.['print.kot_on_send'] || !after?.tickets) return;
    const seen = new Set((before?.tickets ?? []).map((t: any) => t.id));
    const fresh: KotTicket[] = after.tickets.filter((t: any) => !seen.has(t.id)).map((t: any) => ({ ticket: t, items: (after.items ?? []).filter((i: any) => (t.item_ids ?? []).includes(i.id)) }));
    if (fresh.length) await printDoc({ doc: 'kitchen', title: `Kitchen tickets · ${after.number}`, render: (ctx) => <KitchenTicketsDoc tickets={fresh} order={after} ctx={ctx} /> });
  };
  const [settle, setSettle] = useState(false); const [discount, setDiscount] = useState(false); const [voidItem, setVoidItem] = useState<any>(null); const [transfer, setTransfer] = useState(false); const [splitSel, setSplitSel] = useState<string[]>([]); const [cancel, setCancel] = useState(false); const [receipt, setReceipt] = useState<any>(null);
  const inv = ['/orders', '/tables', '/kitchen', '/dashboard', '/shifts'];
  const sendM = useAction(async () => { const items = pending.map((l) => ({ menu_item_id: l.menu_item_id, quantity: l.quantity, modifiers: l.modifiers, special_instructions: l.special_instructions || undefined, course: l.course ?? undefined })); if (!orderId) { const o = await post('/orders', { outlet_id: outlet.id, ...newOrderMeta, items }, true); const sent = await post(`/orders/${o.id}/send`, {}); return { created: o, sent }; } await post(`/orders/${orderId}/items`, { items }); const sent = await post(`/orders/${orderId}/send`, {}); return { sent }; }, { success: 'Sent to kitchen/bar', invalidate: inv, onSuccess: (r: any) => { setPending([]); if (r?.created) onOrderCreated(r.created); else refetch(); void printNewTickets(r?.created ? null : order, r?.sent); } });
  const voidM = useAction((v: any) => post(`/orders/${orderId}/items/${voidItem.id}/void`, v), { success: 'Item voided', invalidate: inv, onSuccess: () => refetch() });
  const discM = useAction((v: any) => post(`/orders/${orderId}/discount`, { ...v, value: Number(v.value), item_id: v.item_id || null }), { success: 'Discount applied', invalidate: inv, onSuccess: () => refetch() });
  const billM = useAction(() => post(`/orders/${orderId}/bill`, {}), { success: 'Bill printed', invalidate: inv, onSuccess: async () => { refetch(); try { const data = await get(`/orders/${orderId}/receipt`); await printDoc({ doc: 'receipt', title: `Bill ${data?.order?.number ?? ''}`, copies: 1, render: (ctx) => <ReceiptDoc data={data} ctx={ctx} kind="bill" /> }); } catch {} } });
  const transferM = useAction((v: any) => post(`/orders/${orderId}/transfer`, v), { success: 'Order transferred', invalidate: inv, onSuccess: () => refetch() });
  const splitM = useAction(() => post(`/orders/${orderId}/split`, { item_ids: splitSel }), { success: 'Order split into a new check', invalidate: inv, onSuccess: () => { setSplitSel([]); refetch(); } });
  const cancelM = useAction((v: any) => post(`/orders/${orderId}/cancel`, v), { success: 'Order cancelled', invalidate: inv, onSuccess: onClosed });
  const pendingTotal = pending.reduce((s, l) => s + (l.price + l.modifiers.reduce((a, m) => a + Number(m.price_delta ?? 0), 0)) * l.quantity, 0);
  const items: any[] = order?.items ?? []; const live = items.filter((i) => !i.voided);
  return <div className="flex h-full flex-col">
    <div className="flex items-center justify-between border-b px-3 py-2"><div><div className="font-semibold">{order ? `Order ${order.number}` : 'New order'} {order && <StatusBadge status={order.status} />}</div><div className="text-[11px] text-muted-foreground">{order ? `${titleCase(order.type)}${order.table_number ? ` · Table ${order.table_number}` : ''}${order.room_number ? ` · Room ${order.room_number}` : ''} · ${order.covers} cover(s) · ${order.waiter_name ?? ''} · ${fmtTime(order.opened_at)}` : `${titleCase(newOrderMeta.type)} · ${outlet?.name}`}</div></div>{order && can('pos.reprint') && <Button size="icon" variant="ghost" onClick={async () => setReceipt(await get(`/orders/${orderId}/receipt`))} title="Receipt"><Printer className="h-4 w-4" /></Button>}</div>
    <div className="flex-1 overflow-y-auto text-sm">
      {live.length > 0 && <div className="divide-y">{live.map((i) => <div key={i.id} className="flex items-start gap-2 px-3 py-1.5">{order?.status === 'OPEN' && can('pos.transfer') && <Checkbox className="mt-1" checked={splitSel.includes(i.id)} onCheckedChange={(v) => setSplitSel((s) => (v ? [...s, i.id] : s.filter((x) => x !== i.id)))} />}<div className="flex-1 min-w-0"><div className="flex justify-between gap-2"><span className="truncate">{i.quantity} × {i.name}</span><span className="tabular">{fmtMoney(i.line_total ?? i.total, currency)}</span></div><div className="text-[11px] text-muted-foreground flex flex-wrap gap-1 items-center">{(i.modifiers ?? []).map((m: any, k: number) => <span key={k}>+{m.name}</span>)}{i.special_instructions && <i>“{i.special_instructions}”</i>}<Badge tone={i.kitchen_status === 'READY' ? 'success' : i.kitchen_status === 'SERVED' ? 'info' : 'muted'}>{titleCase(i.kitchen_status ?? 'NEW')}</Badge>{Number(i.discount) > 0 && <Badge tone="warning">-{fmtMoney(i.discount, currency)}</Badge>}{i.is_complimentary && <Badge tone="info">Comp</Badge>}</div></div>{order?.status === 'OPEN' && can('pos.void_item') && <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => setVoidItem(i)}><Trash2 className="h-3.5 w-3.5" /></Button>}</div>)}</div>}
      {pending.length > 0 && <div className="border-t bg-amber-50/60 dark:bg-amber-950/20"><div className="px-3 pt-2 text-[11px] font-semibold uppercase text-amber-700">Not yet sent</div><div className="divide-y">{pending.map((l, idx) => <div key={idx} className="flex items-center gap-2 px-3 py-1.5"><div className="flex-1 min-w-0"><div className="flex justify-between gap-2"><span className="truncate">{l.name}</span><span className="tabular">{fmtMoney((l.price + l.modifiers.reduce((a, m) => a + Number(m.price_delta ?? 0), 0)) * l.quantity, currency)}</span></div>{(l.modifiers.length > 0 || l.special_instructions) && <div className="text-[11px] text-muted-foreground">{l.modifiers.map((m) => `+${m.name}`).join(' ')} {l.special_instructions && <i>“{l.special_instructions}”</i>}</div>}</div><div className="flex items-center gap-1"><Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setPending(pending.map((x, j) => (j === idx ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))}><Minus className="h-3 w-3" /></Button><span className="w-5 text-center tabular">{l.quantity}</span><Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setPending(pending.map((x, j) => (j === idx ? { ...x, quantity: x.quantity + 1 } : x)))}><Plus className="h-3 w-3" /></Button><Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => setPending(pending.filter((_, j) => j !== idx))}><Trash2 className="h-3 w-3" /></Button></div></div>)}</div></div>}
      {live.length === 0 && pending.length === 0 && <div className="p-6 text-center text-muted-foreground">Tap menu items to add them to the order.</div>}
    </div>
    <div className="border-t p-3 space-y-2 text-sm">
      {order && <div className="space-y-0.5"><div className="flex justify-between"><span>Subtotal</span><span className="tabular">{fmtMoney(order.subtotal, currency)}</span></div>{Number(order.discount_total) > 0 && <div className="flex justify-between text-amber-700"><span>Discount</span><span className="tabular">-{fmtMoney(order.discount_total, currency)}</span></div>}{Number(order.service_charge) > 0 && <div className="flex justify-between"><span>Service charge</span><span className="tabular">{fmtMoney(order.service_charge, currency)}</span></div>}<div className="flex justify-between text-muted-foreground"><span>Tax (incl.)</span><span className="tabular">{fmtMoney(order.tax_total, currency)}</span></div><div className="flex justify-between text-base font-semibold"><span>Total</span><span className="tabular">{fmtMoney(order.total, currency)}</span></div>{Number(order.paid_total) > 0 && <div className="flex justify-between text-emerald-700"><span>Paid</span><span className="tabular">{fmtMoney(order.paid_total, currency)}</span></div>}</div>}
      {pending.length > 0 && <div className="flex justify-between text-amber-700"><span>Unsent items</span><span className="tabular">{fmtMoney(pendingTotal, currency)}</span></div>}
      <div className="grid grid-cols-2 gap-2">
        {pending.length > 0 && can('pos.create_order') && <Button className="col-span-2" loading={sendM.isPending} onClick={() => sendM.mutate(undefined as any)}><Send />Send {pending.length} item(s)</Button>}
        {order && order.status !== 'CLOSED' && order.status !== 'CANCELLED' && <>
          {can('pos.discount') && <Button variant="outline" size="sm" onClick={() => setDiscount(true)}><Percent />Discount</Button>}
          {can('pos.transfer') && <Button variant="outline" size="sm" onClick={() => setTransfer(true)}><ArrowRightLeft />Transfer</Button>}
          {can('pos.transfer') && splitSel.length > 0 && <Button variant="outline" size="sm" onClick={() => splitM.mutate(undefined as any)}><Split />Split {splitSel.length}</Button>}
          {can('pos.cancel_order') && live.length === 0 && <Button variant="ghost" size="sm" onClick={() => setCancel(true)}><Ban />Cancel</Button>}
          {order.status === 'OPEN' && live.length > 0 && <Button variant="outline" size="sm" onClick={() => billM.mutate(undefined as any)}><Receipt />Print bill</Button>}
          {can('pos.settle') && live.length > 0 && <Button size="sm" className={cn(order.status === 'BILLED' && 'col-span-2')} onClick={() => setSettle(true)}><Wallet />Settle {fmtMoney(Number(order.total) - Number(order.paid_total ?? 0), currency)}</Button>}
        </>}
      </div>
    </div>
    {order && <SettleDialog open={settle} onOpenChange={setSettle} order={order} outlet={outlet} onDone={() => { setSettle(false); onClosed(); }} />}
    <ConfirmDialog open={!!voidItem} onOpenChange={(o) => !o && setVoidItem(null)} title={`Void ${voidItem?.name}?`} description="Voids after sending to the kitchen are logged and reported as waste where stock was consumed." destructive confirmLabel="Void item" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => voidM.mutateAsync(v)} />
    <FormDialog open={discount} onOpenChange={setDiscount} title="Apply discount" size="sm" cols={1} initial={{ type: 'PERCENT' }} fields={[{ name: 'type', label: 'Type', type: 'select', options: ['PERCENT', 'FIXED'], required: true }, { name: 'value', label: 'Value', type: 'number', required: true, min: 0 }, { name: 'item_id', label: 'Apply to item (blank = whole order)', type: 'select', options: live.map((i) => ({ value: i.id, label: `${i.quantity} × ${i.name}` })) }, { name: 'reason', label: 'Reason', required: true }]} onSubmit={(v) => discM.mutateAsync(v)} />
    <FormDialog open={transfer} onOpenChange={setTransfer} title="Transfer order" size="sm" cols={1} fields={[{ name: 'table_id', label: 'New table', type: 'lookup', source: '/tables', sourceQuery: { outlet_id: outlet?.id, pageSize: 200 }, sourceLabel: (t: any) => `Table ${t.number} (${t.status})` }, { name: 'waiter_id', label: 'New waiter', type: 'lookup', source: '/users', sourceLabel: 'full_name', sourceQuery: { pageSize: 200 } }, { name: 'reason', label: 'Reason' }]} onSubmit={(v) => transferM.mutateAsync({ table_id: v.table_id || null, waiter_id: v.waiter_id || null, reason: v.reason })} />
    <ConfirmDialog open={cancel} onOpenChange={setCancel} title="Cancel order" destructive confirmLabel="Cancel order" fields={[{ name: 'reason', label: 'Reason', required: true }]} onConfirm={(v) => cancelM.mutateAsync(v)} />
    <Modal open={!!receipt} onOpenChange={(o) => !o && setReceipt(null)} title="Receipt" size="sm">{receipt && <ReceiptView data={receipt} />}<div className="mt-3 flex flex-wrap justify-end gap-2">{receipt?.order?.tickets?.length > 0 && can('pos.reprint') && <PrintButton doc="kitchen" variant="ghost" size="sm" label="Kitchen tickets" title={`Kitchen tickets · ${receipt.order.number}`} render={(ctx) => <KitchenTicketsDoc reprint tickets={receipt.order.tickets.map((t: any) => ({ ticket: t, items: (receipt.order.items ?? []).filter((i: any) => (t.item_ids ?? []).includes(i.id)) }))} order={receipt.order} ctx={ctx} />} />}{receipt && <PrintButton doc="receipt" variant="default" title={`${receipt.order?.status === 'CLOSED' ? 'Receipt' : 'Bill'} ${receipt.order?.number ?? ''}`} render={(ctx) => <ReceiptDoc data={receipt} ctx={ctx} kind={receipt.order?.status === 'CLOSED' ? 'receipt' : 'bill'} />} />}</div></Modal>
  </div>;
}

/** Settlement: split tenders across cash/card/mobile money, room charge (folio), corporate credit or complimentary; enforces the open cashier shift on the server. */
export function SettleDialog({ open, onOpenChange, order, outlet, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; order: any; outlet: any; onDone: () => void }) {
  const { can, currency } = useAuth(); const methods = usePaymentMethods();
  const due = Math.max(0, Number(order.total) - Number(order.paid_total ?? 0));
  const [lines, setLines] = useState<any[]>([{ method: 'PAYMENT', payment_method_id: '', amount: due.toFixed(2), reference: '', tip: '', stay_id: order.stay_id ?? '', customer_id: order.customer_id ?? '' }]);
  const paid = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const m = useAction(() => post(`/orders/${order.id}/settle`, { payments: lines.map((l) => ({ method: l.method, payment_method_id: l.method === 'PAYMENT' ? l.payment_method_id : undefined, amount: Number(l.amount || 0), reference: l.reference || undefined, tip: l.tip ? Number(l.tip) : undefined, stay_id: l.method === 'ROOM_CHARGE' ? l.stay_id : undefined, customer_id: l.method === 'CORPORATE' ? l.customer_id : undefined })) }, true), { success: 'Order settled', invalidate: ['/orders', '/tables', '/shifts', '/folios', '/dashboard'], onSuccess: onDone });
  const upd = (i: number, patch: any) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return <Modal open={open} onOpenChange={onOpenChange} title={`Settle order ${order.number} · ${fmtMoney(due, currency)}`} size="md"><div className="space-y-3">
    {lines.map((l, i) => <div key={i} className="rounded-md border p-3 space-y-2">
      <div className="flex gap-1 flex-wrap">{[['PAYMENT', 'Pay'], ['ROOM_CHARGE', 'Room charge'], ['CORPORATE', 'Corporate'], ['COMPLIMENTARY', 'Comp']].map(([k, label]) => <Button key={k} type="button" size="sm" variant={l.method === k ? 'default' : 'outline'} disabled={(k === 'ROOM_CHARGE' && (!outlet?.allows_room_charge || !can('pos.room_charge'))) || (k === 'COMPLIMENTARY' && !can('pos.discount'))} onClick={() => upd(i, { method: k })}>{label}</Button>)}{lines.length > 1 && <Button type="button" size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>}</div>
      <div className="grid grid-cols-2 gap-2">
        {l.method === 'PAYMENT' && <div className="flex flex-col gap-1"><Label>Method</Label><NativeSelect value={l.payment_method_id} onChange={(e) => upd(i, { payment_method_id: e.target.value })}><option value="">Select…</option>{methods.filter((pm) => !['CORP', 'CORPORATE'].includes(pm.code)).map((pm) => <option key={pm.id} value={pm.id}>{pm.name}</option>)}</NativeSelect></div>}
        {l.method === 'ROOM_CHARGE' && <div className="flex flex-col gap-1"><Label>In-house guest</Label><LookupSelect source="/stays" sourceQuery={{ status: 'IN_HOUSE', pageSize: 300 }} sourceLabel={(s: any) => `Room ${s.room_number} · ${s.guest_name}`} value={l.stay_id} onChange={(v) => upd(i, { stay_id: v })} /></div>}
        {l.method === 'CORPORATE' && <div className="flex flex-col gap-1"><Label>Corporate account</Label><LookupSelect source="/customers" value={l.customer_id} onChange={(v) => upd(i, { customer_id: v })} /></div>}
        {l.method === 'COMPLIMENTARY' && <div className="flex flex-col gap-1"><Label>Reason</Label><Input value={l.reference} onChange={(e) => upd(i, { reference: e.target.value })} placeholder="Manager comp reason" /></div>}
        <div className="flex flex-col gap-1"><Label>Amount</Label><Input type="number" step="0.01" min={0} value={l.amount} onChange={(e) => upd(i, { amount: e.target.value })} className="tabular" /></div>
        {l.method === 'PAYMENT' && <><div className="flex flex-col gap-1"><Label>Reference</Label><Input value={l.reference} onChange={(e) => upd(i, { reference: e.target.value })} placeholder="Card/M-Pesa ref" /></div><div className="flex flex-col gap-1"><Label>Tip</Label><Input type="number" step="0.01" min={0} value={l.tip} onChange={(e) => upd(i, { tip: e.target.value })} /></div></>}
      </div>
    </div>)}
    <div className="flex items-center justify-between text-sm"><Button type="button" variant="outline" size="sm" onClick={() => setLines([...lines, { method: 'PAYMENT', payment_method_id: '', amount: Math.max(0, due - paid).toFixed(2), reference: '', tip: '' }])}><Plus />Split tender</Button><span className={paid + 0.005 >= due ? 'text-emerald-600' : 'text-muted-foreground'}>Tendered {fmtMoney(paid, currency)} / {fmtMoney(due, currency)}{paid > due + 0.005 && ` · change ${fmtMoney(paid - due, currency)}`}</span></div>
    <div className="flex justify-end"><Button loading={m.isPending} disabled={paid + 0.005 < due || lines.some((l) => (l.method === 'PAYMENT' && !l.payment_method_id) || (l.method === 'ROOM_CHARGE' && !l.stay_id) || (l.method === 'CORPORATE' && !l.customer_id))} onClick={() => m.mutate(undefined as any)}><Wallet />Complete sale</Button></div>
  </div></Modal>;
}

/** Printable 80mm-style receipt rendered from GET /orders/:id/receipt. */
export function ReceiptView({ data }: { data: any }) {
  const { currency } = useAuth(); const p = data.property ?? {}; const o = data.order ?? data;
  return <div className="mx-auto w-[300px] bg-white text-black p-3 font-mono text-[11px] leading-tight print:w-full">
    <div className="text-center"><div className="text-sm font-bold">{p.name}</div><div>{p.address}</div><div>{p.phone} {p.tax_number ? `· PIN ${p.tax_number}` : ''}</div><div className="mt-1 font-bold">{o.outlet_name}</div></div>
    <div className="my-2 border-t border-dashed" />
    <div className="flex justify-between"><span>Receipt {o.number}</span><span>{fmtTime(o.closed_at ?? o.opened_at)}</span></div><div>{titleCase(o.type)}{o.table_number ? ` · Table ${o.table_number}` : ''}{o.room_number ? ` · Room ${o.room_number}` : ''} · {o.covers} pax</div><div>Served by {o.waiter_name ?? '—'}</div>
    <div className="my-2 border-t border-dashed" />
    {(o.items ?? []).filter((i: any) => !i.voided).map((i: any) => <div key={i.id} className="flex justify-between"><span>{i.quantity} × {i.name}{(i.modifiers ?? []).length ? ` (${i.modifiers.map((m: any) => m.name).join(', ')})` : ''}</span><span>{fmtMoney(i.line_total, currency)}</span></div>)}
    <div className="my-2 border-t border-dashed" />
    <div className="flex justify-between"><span>Subtotal</span><span>{fmtMoney(o.subtotal, currency)}</span></div>{Number(o.discount_total) > 0 && <div className="flex justify-between"><span>Discount</span><span>-{fmtMoney(o.discount_total, currency)}</span></div>}{Number(o.service_charge) > 0 && <div className="flex justify-between"><span>Service charge</span><span>{fmtMoney(o.service_charge, currency)}</span></div>}<div className="flex justify-between"><span>VAT (incl.)</span><span>{fmtMoney(o.tax_total, currency)}</span></div><div className="flex justify-between font-bold text-xs"><span>TOTAL</span><span>{fmtMoney(o.total, currency)}</span></div>
    {(o.payments ?? []).map((pm: any) => <div key={pm.id} className="flex justify-between"><span>{pm.method_name ?? pm.kind}{pm.reference ? ` ${pm.reference}` : ''}</span><span>{fmtMoney(pm.amount, currency)}</span></div>)}
    <div className="my-2 border-t border-dashed" /><div className="text-center">Thank you for dining with us!</div>
  </div>;
}
