'use client';
/** Thin fetch wrapper: same-origin /api (proxied by Next), bearer token + property header, unified error shape, idempotency keys. */
export class ApiError extends Error { code: string; status: number; details?: any; constructor(status: number, code: string, message: string, details?: any) { super(message); this.status = status; this.code = code; this.details = details; } }
const TOKEN_KEY = 'hms.token', PROP_KEY = 'hms.property';
export const tokenStore = {
  get: () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)),
  set: (t: string | null) => { if (typeof window === 'undefined') return; t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); },
  getProperty: () => (typeof window === 'undefined' ? null : localStorage.getItem(PROP_KEY)),
  setProperty: (p: string | null) => { if (typeof window === 'undefined') return; p ? localStorage.setItem(PROP_KEY, p) : localStorage.removeItem(PROP_KEY); },
};
export const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
interface Opts { method?: string; body?: any; query?: Record<string, any>; idempotent?: boolean; raw?: boolean; formData?: FormData; signal?: AbortSignal }
export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = tokenStore.get(); if (token) headers.Authorization = `Bearer ${token}`;
  const prop = tokenStore.getProperty(); if (prop) headers['X-Property-Id'] = prop;
  if (opts.idempotent) headers['Idempotency-Key'] = uuid();
  let body: any = undefined;
  if (opts.formData) body = opts.formData; else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  let url = `/api${path}`;
  if (opts.query) { const p = new URLSearchParams(); Object.entries(opts.query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); }); const s = p.toString(); if (s) url += (url.includes('?') ? '&' : '?') + s; }
  const res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: opts.signal });
  if (opts.raw) return res as any;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { error: { code: 'BAD_RESPONSE', message: text.slice(0, 200) } }; }
  if (!res.ok) {
    const e = data?.error ?? { code: 'HTTP_' + res.status, message: res.statusText };
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/login')) { tokenStore.set(null); window.dispatchEvent(new Event('hms:logout')); }
    throw new ApiError(res.status, e.code, e.message, e.details);
  }
  return data as T;
}
export const get = <T = any>(path: string, query?: Record<string, any>) => api<T>(path, { query });
export const post = <T = any>(path: string, body?: any, idempotent = false) => api<T>(path, { method: 'POST', body: body ?? {}, idempotent });
export const put = <T = any>(path: string, body?: any) => api<T>(path, { method: 'PUT', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });
/** Download a file (csv/xlsx/pdf export) preserving auth headers. */
export async function download(path: string, query: Record<string, any> = {}, filename?: string) {
  const res: Response = await api(path, { query, raw: true });
  if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error?.message ?? msg; } catch {} throw new ApiError(res.status, 'DOWNLOAD_FAILED', msg); }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? ''; const m = /filename="?([^";]+)"?/.exec(cd);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename ?? (m ? decodeURIComponent(m[1]) : 'download'); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export interface Paged<T> { data: T[]; total: number; page: number; pageSize: number; pages?: number }
