/**
 * Printable document templates. Pure components (no hooks, no providers): they receive the data plus a
 * DocCtx and return markup styled by the print engine's stylesheet. Every template renders sensibly on
 * both sheets (A4/A5/Letter) and rolls (80/58 mm); `ctx.roll` switches between the two structures where a
 * plain CSS difference is not enough.
 */
import React from 'react';
import type { Paper } from './engine';
import { fmtMoney, fmtDate, fmtDateTime, fmtTime, fmtNum, titleCase } from '@/lib/utils';

export interface PrintProperty {
  name: string; address?: string | null; city?: string | null; country?: string | null; phone?: string | null; email?: string | null; website?: string | null;
  tax_number?: string | null; logo_url?: string | null; currency?: string | null; check_in_time?: string | null; check_out_time?: string | null;
  company_name?: string | null; company_legal_name?: string | null; company_tax_number?: string | null;
}
export interface DocCtx { paper: Paper; roll: boolean; property: PrintProperty | null; settings: Record<string, any>; currency: string; now: Date; user?: string | null }

const money = (v: any, ctx: DocCtx, cur?: string | null) => fmtMoney(v, cur || ctx.currency);
const n = (v: any) => Number(v ?? 0);
const hhmm = (t?: string | null) => (t ? String(t).slice(0, 5) : '');
const nonEmpty = (...parts: (string | null | undefined)[]) => parts.filter((p) => p && String(p).trim()).join(', ');

// ------------------------------------------------------------------ shared building blocks
export function Letterhead({ ctx, kind, number, sub, property, outlet }: { ctx: DocCtx; kind: string; number?: string | null; sub?: React.ReactNode; property?: PrintProperty | null; outlet?: string | null }) {
  const p = property ?? ctx.property;
  const showLogo = ctx.settings['print.show_logo'] !== false && !!p?.logo_url;
  const addr = nonEmpty(p?.address, p?.city, p?.country);
  const contact = [p?.phone, p?.email, p?.website].filter(Boolean).join(' · ');
  return <div className="lh">
    <div>
      {showLogo && <img className="logo" src={p!.logo_url!} alt="" />}
      <div className="name">{p?.name ?? 'Hotel'}</div>
      {p?.company_legal_name && p.company_legal_name !== p.name && <div className="addr">{p.company_legal_name}</div>}
      {addr && <div className="addr">{addr}</div>}
      {contact && <div className="addr">{contact}</div>}
      {p?.tax_number && <div className="addr">PIN / Tax No: {p.tax_number}</div>}
      {outlet && <div className="addr b">{outlet}</div>}
    </div>
    <div className="docbox">
      <div className="kind">{kind}</div>
      {number && <div className="no">{number}</div>}
      {sub && <div className="sub">{sub}</div>}
    </div>
  </div>;
}

export function KV({ items }: { items: [string, React.ReactNode][] }) {
  return <dl className="kv">{items.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>;
}

export function Foot({ ctx, text, left }: { ctx: DocCtx; text?: string | null; left?: React.ReactNode }) {
  const stamp = `Printed ${fmtDateTime(ctx.now.toISOString())}${ctx.user ? ` by ${ctx.user}` : ''}`;
  return <div className="foot">{ctx.roll ? <>{text && <span className="b">{text}</span>}<span className="muted">{stamp}</span></> : <><span>{left ?? text ?? ''}</span><span>{stamp}</span></>}</div>;
}

export function Signatures({ labels }: { labels: string[] }) {
  return <div className="sig">{labels.map((l) => <div key={l}>{l}</div>)}</div>;
}

// ------------------------------------------------------------------ POS receipt / bill
/** data = GET /orders/:id/receipt → { property, order } (or an order object). kind 'bill' prints a pre-payment check. */
export function ReceiptDoc({ data, ctx, kind = 'receipt' }: { data: any; ctx: DocCtx; kind?: 'receipt' | 'bill' }) {
  const o = data.order ?? data; const prop = data.property ? { ...(ctx.property ?? {}), ...data.property } : ctx.property;
  const items = (o.items ?? []).filter((i: any) => !i.voided);
  const payments: any[] = o.payments ?? [];
  const paid = payments.reduce((s, p) => s + n(p.amount), 0);
  const tips = payments.reduce((s, p) => s + n(p.tip), 0);
  const change = Math.max(0, paid - n(o.total));
  const isBill = kind === 'bill' || (o.status !== 'CLOSED' && payments.length === 0);
  const title = isBill ? 'Bill' : o.settlement_type === 'ROOM_CHARGE' ? 'Room charge slip' : 'Receipt';
  const when = o.closed_at ?? o.opened_at;
  const where = [o.type ? titleCase(o.type) : null, o.table_number ? `Table ${o.table_number}` : null, o.room_number ? `Room ${o.room_number}` : null, o.covers ? `${o.covers} pax` : null].filter(Boolean).join(' · ');
  const footer = ctx.settings['print.receipt_footer'];
  const modsOf = (i: any) => (i.modifiers ?? []).map((m: any) => m.name).filter(Boolean).join(', ');
  return <div className="doc">
    <Letterhead ctx={ctx} property={prop} kind={title} number={o.number} outlet={o.outlet_name} sub={<>{fmtDate(when)} {fmtTime(when)}</>} />
    {ctx.roll
      ? <div className="note">{where}<br />Served by {o.waiter_name ?? '—'}{o.guest_name ? <><br />Guest: {o.guest_name}</> : null}{o.customer_name ? <><br />Account: {o.customer_name}</> : null}{o.shift_number ? <><br />Shift {o.shift_number}</> : null}</div>
      : <div className="grid"><div className="box"><h4>Order</h4><KV items={[['Outlet', o.outlet_name], ['Type', where], ['Served by', o.waiter_name ?? '—'], ['Opened', fmtDateTime(o.opened_at)], ['Closed', o.closed_at ? fmtDateTime(o.closed_at) : null], ['Business date', fmtDate(o.business_date)]]} /></div>
        <div className="box"><h4>Customer</h4><KV items={[['Guest', o.guest_name], ['Account', o.customer_name], ['Room', o.room_number], ['Cashier shift', o.shift_number], ['Status', titleCase(o.status ?? '')]]} /></div></div>}
    <table className="items">
      <thead>{ctx.roll ? <tr><th className="qty">Qty</th><th>Item</th><th className="r">Amount</th></tr> : <tr><th className="r">Qty</th><th>Item</th><th className="r">Unit price</th><th className="r">Discount</th><th className="r">Amount</th></tr>}</thead>
      <tbody>{items.map((i: any) => {
        const mods = modsOf(i); const note = i.special_instructions;
        return ctx.roll
          ? <tr key={i.id}><td className="qty">{fmtNum(i.quantity, 2)}</td><td>{i.name}{mods && <span className="sub">+ {mods}</span>}{n(i.discount) > 0 && <span className="sub">less discount {money(i.discount, ctx, o.currency)}</span>}{i.is_complimentary && <span className="sub">complimentary</span>}</td><td className="amt">{money(i.line_total ?? i.total, ctx, o.currency)}</td></tr>
          : <tr key={i.id}><td className="r">{fmtNum(i.quantity, 2)}</td><td>{i.name}{mods && <div className="sub">+ {mods}</div>}{note && <div className="sub">“{note}”</div>}{i.is_complimentary && <div className="sub">Complimentary</div>}</td><td className="r">{money(i.unit_price ?? i.price, ctx, o.currency)}</td><td className="r">{n(i.discount) > 0 ? money(i.discount, ctx, o.currency) : ''}</td><td className="r">{money(i.line_total ?? i.total, ctx, o.currency)}</td></tr>;
      })}</tbody>
    </table>
    <div className="totals">
      <div className="row"><span>Subtotal</span><span>{money(o.subtotal, ctx, o.currency)}</span></div>
      {n(o.discount_total) > 0 && <div className="row"><span>Discount</span><span>-{money(o.discount_total, ctx, o.currency)}</span></div>}
      {n(o.service_charge) > 0 && <div className="row"><span>Service charge</span><span>{money(o.service_charge, ctx, o.currency)}</span></div>}
      {n(o.tax_total) > 0 && <div className="row"><span>VAT (included)</span><span>{money(o.tax_total, ctx, o.currency)}</span></div>}
      <div className="row grand"><span>TOTAL</span><span>{money(o.total, ctx, o.currency)}</span></div>
      {!isBill && payments.map((pm: any) => <div className="row" key={pm.id}><span>{pm.method_name ?? titleCase(pm.kind ?? 'Payment')}{pm.reference ? ` · ${pm.reference}` : ''}</span><span>{money(pm.amount, ctx, o.currency)}</span></div>)}
      {!isBill && o.settlement_type === 'ROOM_CHARGE' && <div className="row"><span>Charged to room {o.room_number ?? ''} {o.guest_name ? `(${o.guest_name})` : ''}</span><span>{money(o.total, ctx, o.currency)}</span></div>}
      {!isBill && tips > 0 && <div className="row"><span>Tips</span><span>{money(tips, ctx, o.currency)}</span></div>}
      {!isBill && change > 0.004 && <div className="row b"><span>Change</span><span>{money(change, ctx, o.currency)}</span></div>}
      {isBill && <div className="row"><span>Amount due</span><span className="b">{money(n(o.total) - n(o.paid_total ?? 0), ctx, o.currency)}</span></div>}
    </div>
    {isBill && <div className="note c"><span className="stamp">Not a tax receipt</span></div>}
    {o.notes && <div className="note">Notes: {o.notes}</div>}
    {o.settlement_type === 'ROOM_CHARGE' && !ctx.roll && <Signatures labels={['Guest signature', 'Room no.']} />}
    {o.settlement_type === 'ROOM_CHARGE' && ctx.roll && <div className="sig"><div>Guest signature</div></div>}
    <Foot ctx={ctx} text={footer} />
  </div>;
}

// ------------------------------------------------------------------ Kitchen / bar order tickets
export interface KotTicket { ticket: any; items: any[] }
/** Each ticket prints as its own page (= a cut on roll printers). */
export function KitchenTicketsDoc({ tickets, order, ctx, reprint }: { tickets: KotTicket[]; order: any; ctx: DocCtx; reprint?: boolean }) {
  const where = [order.table_number ? `Table ${order.table_number}` : null, order.room_number ? `Room ${order.room_number}` : null, order.type ? titleCase(order.type) : null].filter(Boolean).join(' · ');
  return <div className="doc kot">{tickets.map(({ ticket, items }, idx) => <div key={ticket.id ?? idx} className={idx > 0 ? 'brk' : undefined}>
    <div className="hdr">{ticket.kitchen_name ?? 'Kitchen'}</div>
    <div className="c b" style={{ fontSize: '1.1em' }}>{reprint ? 'REPRINT · ' : ''}Ticket #{ticket.ticket_no ?? ticket.number ?? ''} · Order {order.number ?? ticket.order_number}</div>
    <div className="c">{where}</div>
    <div className="row"><span>Sent {fmtTime(ticket.sent_at)}</span><span>{order.waiter_name ?? ticket.waiter_name ? `Waiter: ${order.waiter_name ?? ticket.waiter_name}` : ''}</span></div>
    {order.covers ? <div className="row"><span>Covers</span><span>{order.covers}</span></div> : null}
    <div className="rule" />
    {items.map((i: any) => <div key={i.id}>
      <div className="item"><span className="q">{fmtNum(i.quantity, 2)}×</span><span>{i.name}{i.seat_no ? <span className="muted"> · seat {i.seat_no}</span> : null}{i.course ? <span className="muted"> · course {i.course}</span> : null}</span></div>
      {(i.modifiers ?? []).length > 0 && <div className="mods">+ {(i.modifiers ?? []).map((m: any) => m.name).join(', ')}</div>}
      {i.special_instructions && <div className="mods b">“{i.special_instructions}”</div>}
    </div>)}
    {(ticket.notes || order.notes) && <div className="note b" style={{ marginTop: 6 }}>Note: {ticket.notes ?? order.notes}</div>}
    <div className="rule dash" />
    <div className="c muted" style={{ fontSize: '.9em' }}>{items.length} line(s) · sent {fmtDateTime(ticket.sent_at)}</div>
  </div>)}</div>;
}

// ------------------------------------------------------------------ Guest folio / invoice
export function FolioDoc({ folio: f, ctx, kind }: { folio: any; ctx: DocCtx; kind?: 'folio' | 'invoice' | 'statement' }) {
  const items: any[] = f.items ?? [];
  const isCompany = f.type === 'COMPANY' || (!f.guest_name && f.customer_name);
  const title = kind ? { folio: 'Guest folio', invoice: 'Tax invoice', statement: 'Statement' }[kind] : f.status === 'CLOSED' ? 'Tax invoice' : isCompany ? 'Company folio' : 'Guest folio';
  const nights = f.arrival_date && f.departure_date ? Math.max(0, Math.round((new Date(f.departure_date).getTime() - new Date(f.arrival_date).getTime()) / 86400000)) : null;
  let running = 0;
  const cur = f.currency;
  const billTo: [string, React.ReactNode][] = isCompany
    ? [['Company', f.customer_name], ['Address', f.customer_address], ['PIN / Tax No', f.customer_tax_number], ['Phone', f.customer_phone], ['Email', f.customer_email], ['Guest', f.guest_name]]
    : [['Guest', f.guest_name], ['Company', f.guest_company ?? f.customer_name], ['Address', nonEmpty(f.guest_address, f.guest_city, f.guest_country)], ['Phone', f.guest_phone], ['Email', f.guest_email], ['ID', f.guest_id_number ? `${f.guest_id_type ?? 'ID'} ${f.guest_id_number}` : null]];
  const stay: [string, React.ReactNode][] = [['Room', f.room_number ? `${f.room_number}${f.room_type_name ? ` · ${f.room_type_name}` : ''}` : null], ['Arrival', f.arrival_date ? fmtDate(f.arrival_date) : f.check_in_at ? fmtDateTime(f.check_in_at) : null], ['Departure', f.departure_date ? fmtDate(f.departure_date) : f.expected_check_out ? fmtDateTime(f.expected_check_out) : null], ['Nights', nights], ['Guests', f.adults != null ? `${f.adults} adult(s)${f.children ? `, ${f.children} child(ren)` : ''}` : null], ['Reservation', f.reservation_number], ['Folio status', titleCase(f.status ?? '')]];
  return <div className="doc">
    <Letterhead ctx={ctx} kind={title} number={f.number} sub={<>Date {fmtDate(ctx.now.toISOString())}{f.status === 'CLOSED' && f.closed_at ? <><br />Closed {fmtDate(f.closed_at)}</> : null}</>} />
    <div className="grid"><div className="box"><h4>Bill to</h4><KV items={billTo} /></div><div className="box"><h4>Stay</h4><KV items={stay} /></div></div>
    <table className="items">
      <thead>{ctx.roll ? <tr><th>Date / description</th><th className="r">Amount</th></tr> : <tr><th>Date</th><th>Description</th><th className="r">Charges</th><th className="r">Credits</th><th className="r">Balance</th></tr>}</thead>
      <tbody>{items.map((i) => {
        const amt = n(i.amount); const dead = i.is_reversed; running += amt;
        const detail = [i.quantity > 1 ? `${fmtNum(i.quantity, 2)} × ${money(i.unit_price, ctx, cur)}` : null, n(i.tax_amount) > 0 ? `incl. tax ${money(i.tax_amount, ctx, cur)}` : null, i.reason].filter(Boolean).join(' · ');
        const cls = dead ? 'strike' : i.reverses_id ? 'muted' : undefined;
        return ctx.roll
          ? <tr key={i.id} className={cls}><td>{fmtDate(i.business_date)} {i.description}{detail && <span className="sub">{detail}</span>}</td><td className="amt">{amt < 0 ? `(${money(-amt, ctx, cur)})` : money(amt, ctx, cur)}</td></tr>
          : <tr key={i.id} className={cls}><td className="nowrap">{fmtDate(i.business_date)}<div className="sub">#{i.line_no}</div></td><td>{i.description}{detail && <div className="sub">{detail}</div>}<div className="sub">{titleCase(i.category ?? '')}{i.posted_by_name ? ` · ${i.posted_by_name}` : ''}</div></td><td className="r">{amt > 0 ? money(amt, ctx, cur) : ''}</td><td className="r">{amt < 0 ? money(-amt, ctx, cur) : ''}</td><td className="r">{money(running, ctx, cur)}</td></tr>;
      })}</tbody>
      {!ctx.roll && <tfoot><tr><td colSpan={2} className="r">Totals</td><td className="r">{money(f.totals?.charges, ctx, cur)}</td><td className="r">{money(f.totals?.credits, ctx, cur)}</td><td className="r">{money(f.totals?.balance, ctx, cur)}</td></tr></tfoot>}
    </table>
    <div className="totals">
      <div className="row"><span>Total charges</span><span>{money(f.totals?.charges, ctx, cur)}</span></div>
      {n(f.discount_total) > 0 && <div className="row"><span>of which discounts</span><span>-{money(f.discount_total, ctx, cur)}</span></div>}
      {n(f.service_charge_total) > 0 && <div className="row"><span>of which service charge</span><span>{money(f.service_charge_total, ctx, cur)}</span></div>}
      {n(f.tax_total) > 0 && <div className="row"><span>of which VAT / taxes</span><span>{money(f.tax_total, ctx, cur)}</span></div>}
      <div className="row"><span>Payments & credits</span><span>{money(f.totals?.credits, ctx, cur)}</span></div>
      <div className="row grand"><span>{n(f.totals?.balance) < -0.004 ? 'Credit balance' : 'Balance due'}</span><span>{money(Math.abs(n(f.totals?.balance)), ctx, cur)}</span></div>
    </div>
    {ctx.settings['print.document_footer'] && <div className="note pre">{ctx.settings['print.document_footer']}</div>}
    {!ctx.roll && <Signatures labels={['Guest signature', 'Cashier']} />}
    <Foot ctx={ctx} left={`${title} ${f.number} · ${ctx.property?.name ?? ''}`} />
  </div>;
}

// ------------------------------------------------------------------ Reservation confirmation
export function ReservationDoc({ r, ctx }: { r: any; ctx: DocCtx }) {
  const p = ctx.property; const cur = r.currency;
  const nights = n(r.nights) || Math.max(1, Math.round((new Date(r.departure_date).getTime() - new Date(r.arrival_date).getTime()) / 86400000));
  const est = n(r.rate) * nights;
  const deposits: any[] = r.payments ?? [];
  const paid = deposits.reduce((s, x) => s + n(x.amount), 0);
  const policy = r.cancellation_policy || ctx.settings['hotel.cancellation_policy'];
  const others = (r.guests ?? []).filter((g: any) => !g.is_primary && g.id !== r.guest_id);
  return <div className="doc">
    <Letterhead ctx={ctx} kind="Reservation confirmation" number={r.number} sub={<>Status: {titleCase(r.status ?? '')}<br />Issued {fmtDate(ctx.now.toISOString())}</>} />
    {!ctx.roll && <p className="note">Dear {r.guest_name}, thank you for choosing {p?.name ?? 'our hotel'}. We are pleased to confirm the following reservation:</p>}
    <div className="grid">
      <div className="box"><h4>Guest</h4><KV items={[['Name', r.guest_name], ['Phone', r.guest_phone], ['Email', r.guest_email], ['Company / agent', r.customer_name], ['Source', r.source ? titleCase(r.source) : null], ['Reference', r.external_ref]]} /></div>
      <div className="box"><h4>Stay</h4><KV items={[['Arrival', `${fmtDate(r.arrival_date)}${p?.check_in_time ? ` from ${hhmm(p.check_in_time)}` : ''}`], ['Departure', `${fmtDate(r.departure_date)}${p?.check_out_time ? ` by ${hhmm(p.check_out_time)}` : ''}`], ['Nights', nights], ['Room type', r.room_type_name], ['Room', r.room_number ?? 'Assigned at check-in'], ['Guests', `${r.adults} adult(s)${r.children ? `, ${r.children} child(ren)` : ''}`], ['ETA', r.eta]]} /></div>
      <div className="box"><h4>Rate</h4><KV items={[['Rate plan', r.rate_plan_name], ['Meal plan', r.meal_plan ? titleCase(String(r.meal_plan)) : null], ['Nightly rate', money(r.rate, ctx, cur)], ['Estimated total', `${money(est, ctx, cur)} for ${nights} night(s)`], ['Deposit required', n(r.deposit_required) > 0 ? money(r.deposit_required, ctx, cur) : null], ['Deposit paid', paid > 0 ? money(paid, ctx, cur) : null]]} /></div>
    </div>
    {deposits.length > 0 && <table className="items"><thead><tr><th>Date</th><th>Payment</th><th>Reference</th><th className="r">Amount</th></tr></thead><tbody>{deposits.map((d) => <tr key={d.id}><td>{fmtDate(d.created_at)}</td><td>{d.method_name ?? d.kind}</td><td>{d.reference ?? d.number ?? ''}</td><td className="r">{money(d.amount, ctx, cur)}</td></tr>)}</tbody></table>}
    {others.length > 0 && <div className="note"><b>Accompanying guests:</b> {others.map((g: any) => g.name ?? g.full_name).join(', ')}</div>}
    {r.special_requests && <div className="note"><b>Special requests:</b> {r.special_requests}</div>}
    {policy && <div className="note"><b>Cancellation policy:</b> {policy}</div>}
    {ctx.settings['print.document_footer'] && <div className="note pre">{ctx.settings['print.document_footer']}</div>}
    <Foot ctx={ctx} left={p ? `Questions? ${[p.phone, p.email].filter(Boolean).join(' · ')}` : ''} />
  </div>;
}

// ------------------------------------------------------------------ Purchase order
export function PurchaseOrderDoc({ po, ctx }: { po: any; ctx: DocCtx }) {
  const cur = po.currency; const items: any[] = po.items ?? [];
  return <div className="doc">
    <Letterhead ctx={ctx} kind="Purchase order" number={po.number} sub={<>Date {fmtDate(po.order_date)}<br />Status: {titleCase(po.status ?? '')}{po.is_cash_purchase ? ' · cash purchase' : ''}</>} />
    <div className="grid">
      <div className="box"><h4>Supplier</h4><KV items={[['Name', po.supplier_name], ['Code', po.supplier_code], ['Contact', po.supplier_contact], ['Phone', po.supplier_phone], ['Email', po.supplier_email], ['Address', po.supplier_address], ['PIN / Tax No', po.supplier_tax_number]]} /></div>
      <div className="box"><h4>Deliver to</h4><KV items={[['Store', po.store_name], ['Address', po.delivery_address ?? nonEmpty(ctx.property?.address, ctx.property?.city)], ['Expected by', po.expected_date ? fmtDate(po.expected_date) : null], ['Payment terms', po.payment_terms], ['Requisition', po.requisition_number], ['Currency', cur]]} /></div>
    </div>
    <table className="items">
      <thead>{ctx.roll ? <tr><th className="qty">Qty</th><th>Item</th><th className="r">Amount</th></tr> : <tr><th>#</th><th>Item</th><th className="r">Qty</th><th>Unit</th><th className="r">Unit price</th><th className="r">Tax</th><th className="r">Line total</th></tr>}</thead>
      <tbody>{items.map((i, idx) => ctx.roll
        ? <tr key={i.id ?? idx}><td className="qty">{fmtNum(i.quantity, 2)} {i.unit ?? ''}</td><td>{i.product_name ?? i.description}{i.sku && <span className="sub">{i.sku}</span>}<span className="sub">@ {money(i.unit_price, ctx, cur)}</span></td><td className="amt">{money(i.line_total ?? n(i.quantity) * n(i.unit_price), ctx, cur)}</td></tr>
        : <tr key={i.id ?? idx}><td>{idx + 1}</td><td>{i.product_name ?? i.description}{(i.sku || i.description) && <div className="sub">{[i.sku, i.product_name ? i.description : null].filter(Boolean).join(' · ')}</div>}</td><td className="r">{fmtNum(i.quantity, 2)}</td><td>{i.unit ?? ''}</td><td className="r">{money(i.unit_price, ctx, cur)}</td><td className="r">{i.tax_name ?? (n(i.tax_amount) > 0 ? money(i.tax_amount, ctx, cur) : '—')}</td><td className="r">{money(i.line_total ?? n(i.quantity) * n(i.unit_price), ctx, cur)}</td></tr>)}</tbody>
    </table>
    <div className="totals">
      <div className="row"><span>Subtotal</span><span>{money(po.subtotal, ctx, cur)}</span></div>
      {n(po.tax_total) > 0 && <div className="row"><span>Tax</span><span>{money(po.tax_total, ctx, cur)}</span></div>}
      <div className="row grand"><span>Total</span><span>{money(po.total, ctx, cur)}</span></div>
    </div>
    {po.notes && <div className="note"><b>Notes / instructions:</b> {po.notes}</div>}
    <div className="note">Prepared by {po.created_by_name ?? '—'} on {fmtDateTime(po.created_at)}{po.approved_by_name ? ` · Approved by ${po.approved_by_name} on ${fmtDateTime(po.approved_at)}` : ' · Not yet approved'}. Please quote the PO number on delivery notes and invoices.</div>
    {ctx.settings['print.document_footer'] && <div className="note pre">{ctx.settings['print.document_footer']}</div>}
    <Signatures labels={ctx.roll ? ['Authorised signature'] : ['Prepared by', 'Approved by', 'Supplier acknowledgement']} />
    <Foot ctx={ctx} left={`Purchase order ${po.number}`} />
  </div>;
}

// ------------------------------------------------------------------ Banquet event order
export function BeoDoc({ beo, ctx }: { beo: any; ctx: DocCtx }) {
  const e = beo.event ?? {}; const sections: Record<string, any[]> = beo.sections ?? {}; const t = beo.timeline ?? {};
  return <div className="doc">
    <Letterhead ctx={ctx} kind="Banquet event order" number={e.number} sub={<>{e.name}<br />{fmtDate(t.start_at ?? e.start_at)}</>} />
    <div className="grid">
      <div className="box"><h4>Event</h4><KV items={[['Name', e.name], ['Type', e.event_type ? titleCase(e.event_type) : null], ['Venue', e.venue_name ?? 'TBD'], ['Expected guests', e.expected_guests], ['Setup style', e.setup_style], ['Status', titleCase(e.status ?? '')]]} /></div>
      <div className="box"><h4>Client</h4><KV items={[['Client', e.customer_name ?? e.guest_name ?? e.contact_name], ['Contact', e.contact_name], ['Phone', e.contact_phone], ['Email', e.contact_email]]} /></div>
      <div className="box"><h4>Timeline</h4><KV items={[['Setup from', fmtDateTime(t.setup_from)], ['Start', fmtDateTime(t.start_at ?? e.start_at)], ['End', fmtDateTime(t.end_at ?? e.end_at)]]} /></div>
    </div>
    {Object.entries(sections).map(([sec, rows]) => <div key={sec} className="keep"><h2>{titleCase(sec)}</h2><table className="items"><thead><tr><th>Description</th><th className="r">Qty</th>{!ctx.roll && <th className="r">Unit price</th>}{!ctx.roll && <th className="r">Amount</th>}</tr></thead><tbody>{(Array.isArray(rows) ? rows : []).map((r: any, i: number) => <tr key={i}><td>{r.description}</td><td className="r">{fmtNum(r.quantity, 2)}</td>{!ctx.roll && <td className="r">{money(r.unit_price, ctx)}</td>}{!ctx.roll && <td className="r">{money(r.amount, ctx)}</td>}</tr>)}</tbody></table></div>)}
    {[['Menu', e.menu_notes], ['Equipment', e.equipment_notes], ['Staffing', e.staff_notes], ['Notes', e.notes]].filter(([, v]) => v).map(([k, v]) => <div key={k as string} className="keep"><h2>{k}</h2><div className="note pre">{v}</div></div>)}
    <Signatures labels={ctx.roll ? ['Banquet manager'] : ['Banquet manager', 'Executive chef', 'Client']} />
    <Foot ctx={ctx} left={`BEO ${e.number ?? ''} · ${e.name ?? ''}`} />
  </div>;
}

// ------------------------------------------------------------------ Club / event admission ticket
export function TicketDoc({ ticket, event, ticketType, qrSvg, ctx }: { ticket: any; event: any; ticketType?: any; qrSvg?: string; ctx: DocCtx }) {
  const body = <div className="ticket-card">
    <div className="b" style={{ fontSize: '1.2em' }}>{event?.name ?? 'Event'}</div>
    <div>{event?.outlet_name}</div>
    <div>{fmtDate(event?.event_date)} · {hhmm(event?.start_time)}{event?.end_time ? ` – ${hhmm(event.end_time)}` : ''}</div>
    <div className="rule dash" />
    <div className="b">{ticketType?.name ?? ticket.ticket_type ?? 'Admission'} · {ticket.quantity} pax</div>
    <div className="big">{ticket.number}</div>
    {qrSvg ? <div className="qr" dangerouslySetInnerHTML={{ __html: qrSvg }} /> : null}
    <div className="mono" style={{ fontSize: '.8em', wordBreak: 'break-all' }}>{ticket.qr_code}</div>
    <div className="rule dash" />
    <KV items={[['Holder', ticket.holder_name ?? 'Walk-in'], ['Amount', n(ticket.amount) > 0 ? money(ticket.amount, ctx) : 'Complimentary'], ['Status', titleCase(ticket.status ?? 'SOLD')], ['Issued', fmtDateTime(ticket.created_at ?? ctx.now.toISOString())]]} />
    {ticketType?.includes && <div className="note">Includes: {ticketType.includes}</div>}
    <div className="note muted" style={{ fontSize: '.85em' }}>Present this ticket at the door. Valid once for the event above · Non-refundable · Management reserves the right of admission.</div>
  </div>;
  return <div className="doc">
    <Letterhead ctx={ctx} kind="Admission ticket" number={ticket.number} outlet={event?.outlet_name} />
    {body}
    <Foot ctx={ctx} text={ctx.settings['print.receipt_footer']} />
  </div>;
}

// ------------------------------------------------------------------ Cashier shift report (X = open, Z = closed)
export function ShiftReportDoc({ summary, ctx }: { summary: any; ctx: DocCtx }) {
  const s = summary.shift ?? summary; const by: any[] = summary.by_method ?? [];
  const closed = s.status && s.status !== 'OPEN';
  const ins = by.filter((m) => m.direction === 'IN'); const outs = by.filter((m) => m.direction === 'OUT');
  const variance = s.actual_cash != null ? n(s.actual_cash) - n(summary.expected_cash ?? s.expected_cash) : null;
  return <div className="doc">
    <Letterhead ctx={ctx} kind={closed ? 'Shift report (Z)' : 'Shift report (X)'} number={s.number} outlet={s.outlet_name ?? 'Front desk'} sub={<>{fmtDate(s.business_date)}</>} />
    <KV items={[['Cashier', s.cashier_name], ['Opened', fmtDateTime(s.opened_at)], ['Closed', s.closed_at ? fmtDateTime(s.closed_at) : 'Still open'], ['Status', titleCase(s.status ?? '')], ['Terminal', s.terminal_name]]} />
    <h2>Takings by method</h2>
    <table className="items"><thead><tr><th>Method</th><th className="r">Count</th><th className="r">Amount</th></tr></thead>
      <tbody>{ins.map((m, i) => <tr key={i}><td>{m.method}{m.is_cash_drawer ? ' (drawer)' : ''}</td><td className="r">{m.count}</td><td className="r">{money(m.amount, ctx)}</td></tr>)}{ins.length === 0 && <tr><td colSpan={3} className="c muted">No receipts</td></tr>}</tbody>
      <tfoot><tr><td>Total receipts</td><td className="r">{ins.reduce((a, m) => a + n(m.count), 0)}</td><td className="r">{money(ins.reduce((a, m) => a + n(m.amount), 0), ctx)}</td></tr></tfoot></table>
    {outs.length > 0 && <><h2>Paid out / refunds</h2><table className="items"><tbody>{outs.map((m, i) => <tr key={i}><td>{m.method}</td><td className="r">{m.count}</td><td className="r">{money(m.amount, ctx)}</td></tr>)}</tbody></table></>}
    <h2>Cash reconciliation</h2>
    <div className="totals" style={{ marginLeft: 0, width: '100%' }}>
      <div className="row"><span>Opening float</span><span>{money(s.opening_float, ctx)}</span></div>
      <div className="row"><span>+ Cash received</span><span>{money(summary.cash_in, ctx)}</span></div>
      <div className="row"><span>− Cash paid out</span><span>{money(summary.cash_out, ctx)}</span></div>
      <div className="row b"><span>= Expected cash</span><span>{money(summary.expected_cash ?? s.expected_cash, ctx)}</span></div>
      {s.actual_cash != null && <div className="row"><span>Counted cash</span><span>{money(s.actual_cash, ctx)}</span></div>}
      {variance != null && <div className="row grand"><span>Variance</span><span>{variance > 0 ? '+' : ''}{money(variance, ctx)}</span></div>}
      {s.variance_reason && <div className="note">Reason: {s.variance_reason}</div>}
    </div>
    <h2>Activity</h2>
    <KV items={[['Closed orders', summary.orders?.count], ['Sales total', money(summary.orders?.total, ctx)], ['Discounts', money(summary.orders?.discounts, ctx)], ['Voided items', summary.voids], ['Refunds', summary.refunds ? `${summary.refunds.count} · ${money(summary.refunds.total, ctx)}` : null]]} />
    <Signatures labels={ctx.roll ? ['Cashier', 'Supervisor'] : ['Cashier', 'Supervisor', 'Accounts']} />
    <Foot ctx={ctx} left={`Shift ${s.number ?? ''}`} />
  </div>;
}

// ------------------------------------------------------------------ Generic tabular report
export function TableDoc({ title, subtitle, columns, rows, footer, meta, ctx }: { title: string; subtitle?: string; columns: { label: string; align?: 'left' | 'right' | 'center' }[]; rows: React.ReactNode[][]; footer?: React.ReactNode[]; meta?: [string, React.ReactNode][]; ctx: DocCtx }) {
  const dense = columns.length > 7;
  return <div className="doc">
    <Letterhead ctx={ctx} kind={title} sub={subtitle} />
    {meta && meta.length > 0 && <div className="report-meta">{meta.map(([k, v]) => <span key={k} style={{ marginRight: 12 }}><b>{k}:</b> {v}</span>)}</div>}
    <table className={`items${dense ? ' dense' : ''}`}>
      <thead><tr>{columns.map((c, i) => <th key={i} className={c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : undefined}>{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={columns[j]?.align === 'right' ? 'r' : columns[j]?.align === 'center' ? 'c' : undefined}>{v}</td>)}</tr>)}{rows.length === 0 && <tr><td colSpan={columns.length} className="c muted">No data</td></tr>}</tbody>
      {footer && <tfoot><tr>{footer.map((v, j) => <td key={j} className={columns[j]?.align === 'right' ? 'r' : undefined}>{v}</td>)}</tr></tfoot>}
    </table>
    <Foot ctx={ctx} left={`${rows.length} row(s)`} />
  </div>;
}
