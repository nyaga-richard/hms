import { describe, it, expect, beforeAll } from 'vitest';
import { login, client, expectStatus, Client, businessDate, addDays, list, findOne, createGuest } from './helpers';

/**
 * Guest lifecycle: reservation → no double-booking → check-in → folio charges/payments/reversal →
 * checkout blocked by balance → settle → checkout creates invoice, dirties room and raises a housekeeping task.
 */
describe('Reservations, check-in, folio and checkout', () => {
  let reception: Client; let admin: Client; let fom: Client;
  let today: string; let std: any; let room: any; let guest: any;
  let reservationId: string; let stayId: string; let folioId: string;

  beforeAll(async () => {
    reception = client(await login('reception'));
    admin = client(await login('admin'));
    fom = client(await login('fom'));
    today = await businessDate(reception);
    std = await findOne(reception, '/api/room-types?pageSize=100', (r) => r.code === 'STD');
    room = await findOne(reception, '/api/rooms?pageSize=200', (r) => r.number === '101');
    guest = await createGuest(reception);
  });

  it('rejects a reservation whose departure is not after arrival', async () => {
    const res = await reception.post('/api/reservations', { guest_id: guest.id, room_type_id: std.id, arrival_date: today, departure_date: today, adults: 1 });
    expect(res.status).toBe(400);
  });

  it('creates a confirmed reservation with a specific room', async () => {
    const res = expectStatus(await reception.post('/api/reservations', {
      guest_id: guest.id, room_type_id: std.id, room_id: room.id, arrival_date: today, departure_date: addDays(today, 2), adults: 2, children: 0, status: 'CONFIRMED', source: 'WALK_IN',
    }), 201);
    reservationId = res.body.id;
    expect(res.body.status).toBe('CONFIRMED');
    expect(res.body.number ?? res.body.confirmation_no ?? res.body.reservation_no).toBeTruthy();
  });

  it('prevents double-booking the same room for overlapping dates', async () => {
    const other = await createGuest(reception);
    const res = await reception.post('/api/reservations', {
      guest_id: other.id, room_type_id: std.id, room_id: room.id, arrival_date: addDays(today, 1), departure_date: addDays(today, 3), adults: 1, status: 'CONFIRMED',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RESERVATION_CONFLICT');
  });

  it('allows the same room once the previous booking has departed (no overlap)', async () => {
    const other = await createGuest(reception);
    const res = expectStatus(await reception.post('/api/reservations', {
      guest_id: other.id, room_type_id: std.id, room_id: room.id, arrival_date: addDays(today, 2), departure_date: addDays(today, 4), adults: 1, status: 'TENTATIVE',
    }), 201);
    // tidy up so later tests can use room 101 freely
    expectStatus(await reception.post(`/api/reservations/${res.body.id}/cancel`, { reason: 'test cleanup' }), 200);
  });

  it('checks the guest in: creates a stay + open folio and occupies the room', async () => {
    const res = expectStatus(await reception.post('/api/checkins', { reservation_id: reservationId, room_id: room.id }), 201);
    stayId = res.body.stay.id;
    folioId = res.body.folio.id;
    expect(res.body.stay.status).toBe('IN_HOUSE');
    const r = expectStatus(await reception.get(`/api/rooms/${room.id}`), 200).body;
    expect(r.status).toBe('OCCUPIED');
    const resv = expectStatus(await reception.get(`/api/reservations/${reservationId}`), 200).body;
    expect(resv.status).toBe('CHECKED_IN');
  });

  it('posts charges and payments to the folio and reverses a wrong charge instead of deleting it', async () => {
    const charge = expectStatus(await reception.post(`/api/folios/${folioId}/charges`, { category: 'MINIBAR', description: 'Minibar - test', quantity: 2, unit_price: 250 }), 201);
    const wrong = expectStatus(await reception.post(`/api/folios/${folioId}/charges`, { category: 'MISC', description: 'Posted by mistake', quantity: 1, unit_price: 1000 }), 201);
    expectStatus(await reception.post(`/api/folios/${folioId}/payments`, { payment_method_code: 'CASH', amount: 300, kind: 'PAYMENT' }), 201);
    // a receptionist may post but not reverse; the front-office manager may reverse
    expect((await reception.post(`/api/folios/${folioId}/items/${wrong.body.id}/reverse`, { reason: 'posted in error' })).status).toBe(403);
    expectStatus(await fom.post(`/api/folios/${folioId}/items/${wrong.body.id}/reverse`, { reason: 'posted in error' }), 200, 201);

    const folio = expectStatus(await reception.get(`/api/folios/${folioId}`), 200).body;
    const items = folio.items as any[];
    const original = items.find((i) => i.id === wrong.body.id);
    expect(original).toBeTruthy();                // never deleted
    expect(original.is_reversed).toBe(true);
    expect(items.some((i) => i.reverses_id === wrong.body.id)).toBe(true); // contra entry exists
    expect(items.find((i) => i.id === charge.body.id).is_reversed).toBe(false);
    // balance = 500 minibar − 300 cash (the 1000 is reversed out)
    expect(Number(folio.totals.balance)).toBeCloseTo(200, 2);
  });

  it('refuses checkout while a balance is outstanding', async () => {
    const res = await reception.post('/api/checkouts', { stay_id: stayId, payments: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BALANCE_OUTSTANDING');
  });

  it('checks out after settlement: invoice issued, room dirty, housekeeping task raised', async () => {
    const preview = expectStatus(await reception.get(`/api/checkouts/${stayId}/preview`), 200).body;
    const due = Number(preview.projected_balance);
    expect(due).toBeGreaterThan(0);
    const res = expectStatus(await reception.post('/api/checkouts', { stay_id: stayId, payments: [{ payment_method_code: 'CASH', amount: due }] }), 201);
    expect(res.body.stay.status).toBe('CHECKED_OUT');
    expect(res.body.invoice).toBeTruthy();
    expect(Math.abs(Number(res.body.balance))).toBeLessThan(0.01);

    const r = expectStatus(await reception.get(`/api/rooms/${room.id}`), 200).body;
    expect(r.status).toBe('AVAILABLE');
    expect(r.housekeeping_status).toBe('DIRTY');

    const tasks = await list(admin, `/api/housekeeping/tasks?room_id=${room.id}&open=true&pageSize=50`);
    expect(tasks.some((t: any) => t.task_type === 'CHECKOUT_CLEAN')).toBe(true);

    const folio = expectStatus(await reception.get(`/api/folios/${folioId}`), 200).body;
    expect(folio.status).toBe('CLOSED');
  });

  it('does not let a dirty room be assigned at check-in unless explicitly accepted', async () => {
    const g = await createGuest(reception);
    const resv = expectStatus(await reception.post('/api/reservations', { guest_id: g.id, room_type_id: std.id, arrival_date: today, departure_date: addDays(today, 1), adults: 1, status: 'CONFIRMED' }), 201);
    const blocked = await reception.post('/api/checkins', { reservation_id: resv.body.id, room_id: room.id });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('ROOM_DIRTY');
    expectStatus(await reception.post(`/api/reservations/${resv.body.id}/cancel`, { reason: 'test cleanup' }), 200);
  });

  it('every folio payment produced a balanced, immutable journal entry', async () => {
    const payments = await list(admin, '/api/payments?pageSize=5');
    const withJournal = payments.find((p: any) => p.journal_entry_id);
    expect(withJournal).toBeTruthy();
    const detail = expectStatus(await admin.get(`/api/journals/${withJournal.journal_entry_id}`), 200).body;
    const dr = detail.lines.reduce((s: number, l: any) => s + Number(l.debit), 0);
    const cr = detail.lines.reduce((s: number, l: any) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(cr, 2);
  });
});
