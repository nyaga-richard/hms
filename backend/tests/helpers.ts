import request from 'supertest';
import { createApp } from '../src/app';

export const app = createApp();
export const PASSWORD = 'Password123';

export async function login(username: string, password = PASSWORD): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

/** Small authenticated client around supertest. */
export function client(token: string) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('Accept', 'application/json');
  return {
    get: (url: string) => auth(request(app).get(url)),
    post: (url: string, body?: any) => auth(request(app).post(url)).send(body ?? {}),
    put: (url: string, body?: any) => auth(request(app).put(url)).send(body ?? {}),
    del: (url: string) => auth(request(app).delete(url)),
  };
}
export type Client = ReturnType<typeof client>;

/** Throws with the server's error payload when the status is not one of the expected ones. */
export function expectStatus(res: request.Response, ...codes: number[]) {
  if (!codes.includes(res.status)) {
    throw new Error(`Expected HTTP ${codes.join('/')} but got ${res.status}: ${JSON.stringify(res.body).slice(0, 600)}`);
  }
  return res;
}

export function ymd(d: Date) { return d.toISOString().slice(0, 10); }
export function addDays(iso: string, n: number) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }

export async function businessDate(c: Client): Promise<string> {
  const res = expectStatus(await c.get('/api/business-days/current'), 200);
  return String(res.body.business_date).slice(0, 10);
}

/** First page of a list endpoint. */
export async function list(c: Client, url: string): Promise<any[]> {
  const res = expectStatus(await c.get(url), 200);
  return Array.isArray(res.body) ? res.body : res.body.data;
}

export async function findOne(c: Client, url: string, pred: (row: any) => boolean) {
  const rows = await list(c, url);
  const row = rows.find(pred);
  if (!row) throw new Error(`No row matched in ${url}; got ${rows.length} rows`);
  return row;
}

let guestSeq = 0;
export async function createGuest(c: Client, overrides: any = {}) {
  guestSeq += 1;
  const stamp = Date.now().toString(36) + guestSeq;
  const res = expectStatus(await c.post('/api/guests', {
    first_name: 'Test', last_name: `Guest ${stamp}`, phone: `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    email: `guest.${stamp}@example.test`, nationality: 'KE', ...overrides,
  }), 201);
  return res.body;
}
