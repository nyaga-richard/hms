/**
 * Renders every print template against live API data on every paper size and writes the HTML documents to
 * frontend/.cache/print-preview/ so they can be opened in a browser (Ctrl+P) or fed to a headless browser.
 * Usage: API_URL=http://localhost:4000/api TOKEN=... npx tsx scripts/print-preview.tsx
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { buildDocument, PAPER_ORDER, isRoll, type Paper, type DocType } from '../src/lib/print/engine';
import { ReceiptDoc, KitchenTicketsDoc, FolioDoc, ReservationDoc, PurchaseOrderDoc, BeoDoc, TicketDoc, ShiftReportDoc, TableDoc, type DocCtx } from '../src/lib/print/templates';

const API = process.env.API_URL ?? 'http://localhost:4000/api';
const TOKEN = process.env.TOKEN ?? fs.readFileSync('/tmp/tok', 'utf8').trim();
const out = path.resolve(__dirname, '../.cache/print-preview'); fs.mkdirSync(out, { recursive: true });
const get = async (p: string) => { const r = await fetch(API + p, { headers: { Authorization: `Bearer ${TOKEN}` } }); if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`); return r.json(); };
const first = async (p: string) => (await get(p)).data?.[0];

async function main() {
  const profile = await get('/print/profile');
  const ctxFor = (paper: Paper): DocCtx => ({ paper, roll: isRoll(paper), property: profile.property, settings: profile.settings, currency: profile.property?.currency ?? 'KES', now: new Date(), user: 'Preview' });
  const jobs: { doc: DocType; name: string; render: (ctx: DocCtx) => Promise<React.ReactElement> | React.ReactElement }[] = [];

  const order = await first('/orders?status=CLOSED&pageSize=1') ?? await first('/orders?pageSize=1');
  if (order) {
    const receipt = await get(`/orders/${order.id}/receipt`).catch(() => null);
    const o = await get(`/orders/${order.id}`);
    if (receipt) jobs.push({ doc: 'receipt', name: 'receipt', render: (ctx) => <ReceiptDoc data={receipt} ctx={ctx} kind="receipt" /> });
    jobs.push({ doc: 'receipt', name: 'bill', render: (ctx) => <ReceiptDoc data={{ order: o }} ctx={ctx} kind="bill" /> });
    if (o.tickets?.length) jobs.push({ doc: 'kitchen', name: 'kot', render: (ctx) => <KitchenTicketsDoc tickets={o.tickets.map((t: any) => ({ ticket: t, items: (o.items ?? []).filter((i: any) => (t.item_ids ?? []).includes(i.id)) }))} order={o} ctx={ctx} /> });
  }
  const kt = (await get('/kitchen/tickets')).data?.[0];
  if (kt) jobs.push({ doc: 'kitchen', name: 'kds-ticket', render: (ctx) => <KitchenTicketsDoc tickets={[{ ticket: kt, items: kt.items ?? [] }]} order={{ number: kt.order_number, type: kt.order_type, table_number: kt.table_number, room_number: kt.room_number, waiter_name: kt.waiter_name }} ctx={ctx} /> });
  const folio = await first('/folios?pageSize=1');
  if (folio) { const f = await get(`/folios/${folio.id}`); jobs.push({ doc: 'folio', name: 'folio', render: (ctx) => <FolioDoc folio={f} ctx={ctx} /> }); }
  const res = await first('/reservations?pageSize=1');
  if (res) { const r = await get(`/reservations/${res.id}`); jobs.push({ doc: 'confirmation', name: 'reservation', render: (ctx) => <ReservationDoc r={r} ctx={ctx} /> }); }
  const po = await first('/purchase-orders?pageSize=1');
  if (po) { const p = await get(`/purchase-orders/${po.id}`); jobs.push({ doc: 'purchase_order', name: 'purchase-order', render: (ctx) => <PurchaseOrderDoc po={p} ctx={ctx} /> }); }
  const ev = await first('/events?pageSize=1');
  if (ev) { const beo = await get(`/events/${ev.id}/beo`).catch(() => null); if (beo) jobs.push({ doc: 'beo', name: 'beo', render: (ctx) => <BeoDoc beo={beo} ctx={ctx} /> }); }
  for (const ce of (await get('/club-events?pageSize=10')).data ?? []) { const t = (await get(`/club-events/${ce.id}/tickets?pageSize=1`)).data?.[0]; if (!t) continue; const event = await get(`/club-events/${ce.id}`); jobs.push({ doc: 'ticket', name: 'ticket', render: async (ctx) => <TicketDoc ticket={t} event={event} ticketType={(event.ticket_types ?? []).find((x: any) => x.name === t.ticket_type)} qrSvg={t.qr_code ? await QRCode.toString(t.qr_code, { type: 'svg', margin: 0 }) : undefined} ctx={ctx} /> }); break; }
  const sh = await first('/shifts?pageSize=1');
  if (sh) { const s = await get(`/shifts/${sh.id}`); jobs.push({ doc: 'shift', name: 'shift', render: (ctx) => <ShiftReportDoc summary={s} ctx={ctx} /> }); }
  const rep = await get('/reports/pos_sales?from=2026-01-01&to=2026-12-31').catch(() => null);
  if (rep) jobs.push({ doc: 'report', name: 'report', render: (ctx) => <TableDoc title="POS sales" subtitle="2026" columns={rep.columns.map((c: string) => ({ label: c, align: typeof rep.rows[0]?.[c] === 'number' ? 'right' : 'left' }))} rows={rep.rows.map((r: any) => rep.columns.map((c: string) => String(r[c] ?? '')))} ctx={ctx} /> });

  const index: string[] = [];
  for (const j of jobs) for (const paper of PAPER_ORDER) {
    const ctx = ctxFor(paper);
    const el = await j.render(ctx);
    const html = buildDocument({ title: `${j.name} (${paper})`, bodyHtml: renderToStaticMarkup(el), paper, copies: 1 });
    const file = `${j.name}.${paper}.html`; fs.writeFileSync(path.join(out, file), html); index.push(file);
  }
  fs.writeFileSync(path.join(out, 'index.html'), `<ul>${index.map((f) => `<li><a href="${f}">${f}</a></li>`).join('')}</ul>`);
  console.log(`wrote ${index.length} documents to ${out}`); console.log(index.join('\n'));
}
main().catch((e) => { console.error(e); process.exit(1); });
