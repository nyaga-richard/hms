'use client';
import React from 'react';
import { useParams } from 'next/navigation';
import { useApi } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { PageHeader, Section, KV } from '@/components/shared/page';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { fmtDateTime, fmtMoney, titleCase } from '@/lib/utils';
import { ReceiptView } from '@/components/pos/order-panel';
import { AuditTrail } from '@/components/shared/audit-trail';
import { PrintButton, ReceiptDoc, KitchenTicketsDoc } from '@/lib/print';
export default function OrderDetail() {
  const { id } = useParams<{ id: string }>(); const { currency } = useAuth();
  const { data: o, isLoading } = useApi<any>(`/orders/${id}`); const { data: receipt } = useApi<any>(`/orders/${id}/receipt`);
  if (isLoading || !o) return <Spinner />;
  return <div className="space-y-4">
    <PageHeader crumbs={[{ label: 'POS', href: '/pos' }, { label: 'Orders', href: '/pos/orders' }, { label: o.number }]} title={<span className="flex items-center gap-2">Order {o.number} <StatusBadge status={o.status} /></span>} subtitle={`${o.outlet_name} · ${titleCase(o.type)}${o.table_number ? ` · Table ${o.table_number}` : ''}${o.room_number ? ` · Room ${o.room_number}` : ''} · ${fmtDateTime(o.opened_at)}`} actions={<div className="flex flex-wrap gap-2">{o.tickets?.length > 0 && <PrintButton doc="kitchen" variant="ghost" label="Kitchen tickets" title={`Kitchen tickets · ${o.number}`} render={(ctx) => <KitchenTicketsDoc reprint tickets={o.tickets.map((t: any) => ({ ticket: t, items: (o.items ?? []).filter((i: any) => (t.item_ids ?? []).includes(i.id)) }))} order={o} ctx={ctx} />} />}<PrintButton doc="receipt" title={`${o.status === 'CLOSED' ? 'Receipt' : 'Bill'} ${o.number}`} disabled={!receipt} render={(ctx) => <ReceiptDoc data={receipt ?? { order: o }} ctx={ctx} kind={o.status === 'CLOSED' ? 'receipt' : 'bill'} />} /></div>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        <Section title="Items"><table className="w-full text-sm"><thead className="text-xs uppercase text-muted-foreground"><tr><th className="text-left py-1">Item</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">Discount</th><th className="text-right">Total</th><th>Kitchen</th></tr></thead><tbody className="divide-y">{o.items.map((i: any) => <tr key={i.id} className={i.voided ? 'line-through text-muted-foreground' : ''}><td className="py-1">{i.name}{(i.modifiers ?? []).length > 0 && <div className="text-xs text-muted-foreground">{i.modifiers.map((m: any) => m.name).join(', ')}</div>}{i.void_reason && <div className="text-xs text-red-600">void: {i.void_reason}</div>}</td><td className="text-right tabular">{i.quantity}</td><td className="text-right tabular">{fmtMoney(i.unit_price, currency)}</td><td className="text-right tabular">{fmtMoney(i.discount, currency)}</td><td className="text-right tabular">{fmtMoney(i.line_total, currency)}</td><td className="text-center"><Badge tone="muted">{titleCase(i.kitchen_status ?? '')}</Badge></td></tr>)}</tbody></table>
          <KV cols={4} className="mt-3" items={[['Subtotal', fmtMoney(o.subtotal, currency)], ['Discount', fmtMoney(o.discount_total, currency)], ['Service charge', fmtMoney(o.service_charge, currency)], ['Tax', fmtMoney(o.tax_total, currency)], ['Total', <b key="t">{fmtMoney(o.total, currency)}</b>], ['Paid', fmtMoney(o.paid_total, currency)], ['COGS', fmtMoney(o.cogs_total, currency)], ['Settlement', titleCase(o.settlement_type ?? '—')]]} /></Section>
        <Section title="Payments">{o.payments?.length ? <ul className="divide-y text-sm">{o.payments.map((p: any) => <li key={p.id} className="flex justify-between py-1"><span>{p.payment_number ?? p.number} · {p.method_name} · {p.kind}{p.reference ? ` · ${p.reference}` : ''}</span><span className="tabular">{fmtMoney(p.amount, currency)}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">No payments{o.settlement_type === 'ROOM_CHARGE' ? ' — charged to guest folio' : ''}.</p>}</Section>
        <Section title="Kitchen tickets">{o.tickets?.length ? <ul className="text-sm divide-y">{o.tickets.map((t: any) => <li key={t.id} className="py-1 flex justify-between"><span>{t.kitchen_name} · {t.number ?? t.id.slice(0, 8)}</span><span><StatusBadge status={t.status} /> {fmtDateTime(t.sent_at)}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">None.</p>}</Section>
      </div>
      <div className="space-y-4"><KV cols={1} items={[['Waiter', o.waiter_name ?? '—'], ['Cashier shift', o.shift_number ?? '—'], ['Guest', o.guest_name ?? '—'], ['Company', o.customer_name ?? '—'], ['Business date', o.business_date], ['Closed', o.closed_at ? fmtDateTime(o.closed_at) : '—'], ['Journal', o.journal_entry_id ? 'Posted' : '—'], ['Notes', o.notes ?? '—']]} />{receipt && <div className="rounded-lg border p-2 overflow-auto"><ReceiptView data={receipt} /></div>}<AuditTrail entity="order" entityId={id} /></div>
    </div>
  </div>;
}
