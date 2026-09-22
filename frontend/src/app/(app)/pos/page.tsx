'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { Search, Utensils, Coffee, ShoppingBag, BedDouble, ChevronLeft, Users, LockOpen } from 'lucide-react';
import { useApi, useAction } from '@/lib/query';
import { post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner, Empty } from '@/components/ui/misc';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { Modal } from '@/components/ui/dialog';
import { FormDialog, LookupSelect } from '@/components/shared/form';
import { cn, fmtMoney, fmtTime, titleCase } from '@/lib/utils';
import { OrderPanel } from '@/components/pos/order-panel';

const TABLE_COLORS: Record<string, string> = { AVAILABLE: 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30', OCCUPIED: 'border-sky-500 bg-sky-50 dark:bg-sky-950/30', RESERVED: 'border-violet-400 bg-violet-50 dark:bg-violet-950/30', CLEANING: 'border-amber-400 bg-amber-50 dark:bg-amber-950/30', BLOCKED: 'border-slate-400 bg-slate-100' };
/** POS terminal: outlet → tables/orders → menu → order panel. Works for restaurants, bars and clubs (same outlet model). Touch-friendly. */
export default function PosPage() {
  const { can, currency } = useAuth();
  const { data: outlets } = useApi<any>('/outlets', { pageSize: 100, active: 'true' });
  const [outletId, setOutletId] = useState<string>(''); const outlet = (outlets?.data ?? []).find((o: any) => o.id === outletId);
  useEffect(() => { if (!outletId && outlets?.data?.length) setOutletId(localStorage.getItem('hms.pos.outlet') ?? outlets.data[0].id); }, [outlets, outletId]);
  useEffect(() => { if (outletId) localStorage.setItem('hms.pos.outlet', outletId); }, [outletId]);
  const { data: shift } = useApi<any>('/shifts/current', undefined, { refetchInterval: 60000 });
  const { data: tables, refetch: refetchTables } = useApi<any>(outletId ? '/tables' : null, { outlet_id: outletId, pageSize: 200, sort: 'number', order: 'asc' }, { refetchInterval: 20000 });
  const { data: openOrders, refetch: refetchOrders } = useApi<any>(outletId ? '/orders' : null, { outlet_id: outletId, status: 'OPEN,BILLED', pageSize: 100 }, { refetchInterval: 20000 });
  const { data: menu } = useApi<any>(outletId ? `/menus/for-outlet/${outletId}` : null);
  const [orderId, setOrderId] = useState<string | null>(null); const [meta, setMeta] = useState<any>({ type: 'DINE_IN', table_id: null, covers: 2, stay_id: null }); const [screen, setScreen] = useState<'floor' | 'order'>('floor');
  const [pending, setPending] = useState<any[]>([]); const [cat, setCat] = useState<string>(''); const [q, setQ] = useState(''); const [modItem, setModItem] = useState<any>(null); const [modSel, setModSel] = useState<any[]>([]); const [instr, setInstr] = useState(''); const [newOrder, setNewOrder] = useState<null | { type: string }>(null); const [openShift, setOpenShift] = useState(false);
  const openShiftM = useAction((v: any) => post('/shifts/open', { ...v, outlet_id: outletId || null }), { success: 'Shift opened', invalidate: ['/shifts'] });
  const categories: any[] = menu?.categories ?? []; const activeCat = categories.find((c) => c.id === cat) ?? categories[0];
  const items: any[] = useMemo(() => { const all = q ? categories.flatMap((c) => c.items) : activeCat?.items ?? []; return all.filter((i: any) => i.is_available !== false && (!q || i.name.toLowerCase().includes(q.toLowerCase()) || (i.code ?? '').toLowerCase().includes(q.toLowerCase()))); }, [categories, activeCat, q]);
  const tableList: any[] = tables?.data ?? []; const orders: any[] = openOrders?.data ?? [];
  const startOrder = (m: any) => { setMeta(m); setOrderId(null); setPending([]); setScreen('order'); };
  const openExisting = (id: string) => { setOrderId(id); setPending([]); setScreen('order'); };
  const addItem = (it: any) => { if ((it.modifiers ?? []).length > 0) { setModItem(it); setModSel([]); setInstr(''); return; } pushLine(it, [], ''); };
  const pushLine = (it: any, mods: any[], si: string) => setPending((p) => { const key = (l: any) => `${l.menu_item_id}|${JSON.stringify(l.modifiers)}|${l.special_instructions ?? ''}`; const line = { menu_item_id: it.id, name: it.name, price: Number(it.price), quantity: 1, modifiers: mods, special_instructions: si || undefined }; const idx = p.findIndex((l) => key(l) === key(line)); if (idx >= 0) return p.map((l, i) => (i === idx ? { ...l, quantity: l.quantity + 1 } : l)); return [...p, line]; });
  const backToFloor = () => { setScreen('floor'); setOrderId(null); setPending([]); refetchTables(); refetchOrders(); };
  if (!outlets) return <Spinner />;
  const OutletIcon = outlet?.type === 'BAR' ? Coffee : Utensils;
  return <div className="-m-4 md:-m-6 flex h-[calc(100vh-3.5rem)] flex-col">
    <div className="flex items-center gap-2 border-b bg-card px-3 py-2">
      {screen === 'order' && <Button size="sm" variant="ghost" onClick={backToFloor}><ChevronLeft />Floor</Button>}
      <OutletIcon className="h-4 w-4 text-muted-foreground" /><NativeSelect className="h-8 w-48 text-sm" value={outletId} onChange={(e) => { setOutletId(e.target.value); backToFloor(); }}>{(outlets.data ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</NativeSelect>
      <div className="ml-auto flex items-center gap-2 text-xs">{shift?.shift ? <Badge tone="success">Shift {shift.shift.number ?? ''} open · float {fmtMoney(shift.shift.opening_float, currency)}</Badge> : <><Badge tone="warning">No open cashier shift</Badge>{can('pos.open_shift') && <Button size="sm" variant="outline" onClick={() => setOpenShift(true)}><LockOpen />Open shift</Button>}</>}</div>
    </div>
    {screen === 'floor' ? <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <div className="flex flex-wrap gap-2">{can('pos.create_order') && <>{outlet?.allows_takeaway && <Button variant="outline" onClick={() => setNewOrder({ type: 'TAKEAWAY' })}><ShoppingBag />Takeaway</Button>}<Button variant="outline" onClick={() => setNewOrder({ type: 'COUNTER' })}><Coffee />Counter sale</Button>{outlet?.allows_room_charge && <Button variant="outline" onClick={() => setNewOrder({ type: 'ROOM_SERVICE' })}><BedDouble />Room service</Button>}{outlet?.allows_delivery && <Button variant="outline" onClick={() => setNewOrder({ type: 'DELIVERY' })}>Delivery</Button>}</>}</div>
      {tableList.length > 0 && <div><div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Tables</div><div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8 gap-2">{tableList.map((t) => { const o = t.current_order; return <button type="button" key={t.id} onClick={() => (o ? openExisting(o.id) : can('pos.create_order') && startOrder({ type: 'DINE_IN', table_id: t.id, covers: Math.min(t.capacity, 2) }))} className={cn('rounded-lg border-2 p-3 text-left min-h-[84px]', TABLE_COLORS[o ? 'OCCUPIED' : t.status])}><div className="flex items-center justify-between"><span className="text-lg font-bold">{t.number}</span><span className="text-[11px] text-muted-foreground flex items-center gap-0.5"><Users className="h-3 w-3" />{o?.covers ?? t.capacity}</span></div>{o ? <><div className="text-[11px] truncate">{o.number} · {o.waiter}</div><div className="text-sm font-semibold tabular">{fmtMoney(o.total, currency)}</div><div className="text-[10px] text-muted-foreground">{fmtTime(o.opened_at)} {o.status === 'BILLED' && <Badge tone="warning">billed</Badge>}</div></> : <div className="text-[11px] text-muted-foreground">{t.section_name ?? titleCase(t.status)}</div>}</button>; })}</div></div>}
      {orders.filter((o) => !o.table_id).length > 0 && <div><div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Open orders without table</div><div className="grid gap-2 sm:grid-cols-2 md:grid-cols-4">{orders.filter((o) => !o.table_id).map((o) => <button type="button" key={o.id} onClick={() => openExisting(o.id)} className="rounded-lg border-2 border-sky-400 bg-sky-50 dark:bg-sky-950/30 p-3 text-left"><div className="flex justify-between"><span className="font-semibold">{o.number}</span><Badge tone="muted">{titleCase(o.type)}</Badge></div><div className="text-[11px] text-muted-foreground">{o.room_number ? `Room ${o.room_number} · ` : ''}{o.guest_name ?? ''} {o.waiter_name ?? ''} · {fmtTime(o.opened_at)}</div><div className="font-semibold tabular">{fmtMoney(o.total, currency)}</div></button>)}</div></div>}
      {tableList.length === 0 && orders.length === 0 && <Empty title="No tables configured for this outlet" hint="Add tables under POS → Outlets, or start a counter/takeaway sale." />}
    </div> : <div className="flex flex-1 min-h-0">
      <div className="flex flex-1 min-w-0 flex-col">
        <div className="flex items-center gap-2 border-b p-2"><div className="relative flex-1"><Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search menu…" className="pl-8" /></div></div>
        <div className="flex gap-1 overflow-x-auto border-b p-2">{categories.map((c) => <Button key={c.id} size="sm" variant={(activeCat?.id === c.id && !q) ? 'default' : 'outline'} onClick={() => { setCat(c.id); setQ(''); }}>{c.name}</Button>)}</div>
        <div className="flex-1 overflow-y-auto p-2"><div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5 gap-2">{items.map((it) => <button type="button" key={it.id} disabled={!can('pos.create_order')} onClick={() => addItem(it)} className="rounded-lg border bg-card p-3 text-left hover:border-primary hover:shadow-sm active:scale-[0.98] transition min-h-[76px]"><div className="font-medium leading-tight line-clamp-2">{it.name}</div><div className="mt-1 flex items-center justify-between text-xs text-muted-foreground"><span>{it.code}</span><span className="font-semibold text-foreground tabular">{fmtMoney(it.price, currency)}</span></div>{(it.modifiers ?? []).length > 0 && <div className="text-[10px] text-primary">modifiers</div>}</button>)}{items.length === 0 && <div className="col-span-full p-6 text-center text-sm text-muted-foreground">{categories.length === 0 ? 'No active menu assigned to this outlet. Configure menus under POS → Menus.' : 'No items'}</div>}</div></div>
      </div>
      <div className="w-[340px] shrink-0 border-l bg-card hidden md:block"><OrderPanel orderId={orderId} outlet={outlet} pending={pending} setPending={setPending} onClosed={backToFloor} onOrderCreated={(o) => setOrderId(o.id)} newOrderMeta={meta} /></div>
    </div>}
    {screen === 'order' && <div className="md:hidden border-t bg-card max-h-[45vh] overflow-hidden"><OrderPanel orderId={orderId} outlet={outlet} pending={pending} setPending={setPending} onClosed={backToFloor} onOrderCreated={(o) => setOrderId(o.id)} newOrderMeta={meta} /></div>}
    <Modal open={!!modItem} onOpenChange={(o) => !o && setModItem(null)} title={modItem?.name} size="sm">{modItem && <div className="space-y-3">
      {Object.entries((modItem.modifiers as any[]).reduce((g: any, m: any) => { (g[m.group_name ?? 'Options'] ??= []).push(m); return g; }, {})).map(([group, ms]: any) => <div key={group}><div className="text-xs font-semibold uppercase text-muted-foreground mb-1">{group}</div><div className="flex flex-wrap gap-1">{ms.map((m: any) => { const on = modSel.some((x) => x.id === m.id); return <Button key={m.id} type="button" size="sm" variant={on ? 'default' : 'outline'} onClick={() => setModSel(on ? modSel.filter((x) => x.id !== m.id) : [...modSel.filter((x) => (m.max_select === 1 ? x.group_name !== m.group_name : true)), m])}>{m.name}{Number(m.price_delta) ? ` +${fmtMoney(m.price_delta, currency)}` : ''}</Button>; })}</div></div>)}
      <div className="flex flex-col gap-1"><Label>Special instructions</Label><Input value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="e.g. no onions" /></div>
      <div className="flex justify-end"><Button onClick={() => { pushLine(modItem, modSel.map((m) => ({ id: m.id, name: m.name, price_delta: Number(m.price_delta ?? 0), product_id: m.product_id, product_qty: m.product_qty })), instr); setModItem(null); }}>Add to order</Button></div>
    </div>}</Modal>
    <Modal open={!!newOrder} onOpenChange={(o) => !o && setNewOrder(null)} title={`New ${titleCase(newOrder?.type ?? '')} order`} size="sm">{newOrder && <NewOrderForm type={newOrder.type} onStart={(m) => { setNewOrder(null); startOrder(m); }} />}</Modal>
    <FormDialog open={openShift} onOpenChange={setOpenShift} title={`Open cashier shift · ${outlet?.name ?? ''}`} size="sm" cols={1} initial={{ opening_float: 0 }} fields={[{ name: 'opening_float', label: 'Opening cash float', type: 'money', required: true }, { name: 'notes', label: 'Notes' }]} submitLabel="Open shift" onSubmit={(v) => openShiftM.mutateAsync(v)} />
  </div>;
}
function NewOrderForm({ type, onStart }: { type: string; onStart: (m: any) => void }) {
  const [covers, setCovers] = useState(1); const [stay, setStay] = useState(''); const [notes, setNotes] = useState('');
  return <div className="space-y-3">
    {type === 'ROOM_SERVICE' && <div className="flex flex-col gap-1"><Label>Room / guest</Label><LookupSelect source="/stays" sourceQuery={{ status: 'IN_HOUSE', pageSize: 300 }} sourceLabel={(s: any) => `Room ${s.room_number} · ${s.guest_name}`} value={stay} onChange={setStay} /></div>}
    <div className="flex flex-col gap-1"><Label>Covers</Label><Input type="number" min={1} value={covers} onChange={(e) => setCovers(Number(e.target.value))} /></div>
    <div className="flex flex-col gap-1"><Label>{type === 'DELIVERY' ? 'Delivery address / notes' : 'Notes'}</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
    <div className="flex justify-end"><Button disabled={type === 'ROOM_SERVICE' && !stay} onClick={() => onStart({ type, covers, stay_id: stay || null, notes: notes || undefined, delivery_address: type === 'DELIVERY' ? notes : undefined })}>Start order</Button></div>
  </div>;
}
