import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const fmtMoney = (v: any, currency = 'KES') => { const n = Number(v ?? 0); return new Intl.NumberFormat('en-KE', { style: 'currency', currency, maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(n); };
export const fmtNum = (v: any, d = 0) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const fmtDate = (v?: string | null) => (v ? new Date(String(v).length === 10 ? v + 'T00:00:00' : v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (v?: string | null) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtTime = (v?: string | null) => (v ? new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const titleCase = (s?: string | null) => (s ?? '').toString().replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
export const initials = (name?: string) => (name ?? '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export function statusTone(s?: string | null): 'default' | 'success' | 'warning' | 'destructive' | 'info' | 'muted' {
  const v = (s ?? '').toUpperCase();
  if (['CONFIRMED', 'APPROVED', 'POSTED', 'PAID', 'COMPLETED', 'CLOSED', 'CLEAN', 'INSPECTED', 'VERIFIED', 'AVAILABLE', 'CHECKED_IN', 'IN_HOUSE', 'ACTIVE', 'RECEIVED', 'SETTLED', 'DONE', 'ISSUED', 'OPEN', 'LIVE', 'SOLD', 'IN_USE', 'INVOICED', 'READY'].includes(v)) return 'success';
  if (['PENDING', 'PENDING_APPROVAL', 'TENTATIVE', 'DIRTY', 'IN_PROGRESS', 'PARTIALLY_RECEIVED', 'PARTIALLY_PAID', 'BILLED', 'SENT', 'PREPARING', 'ACCEPTED', 'REVIEW', 'COUNTING', 'DRAFT', 'INQUIRY', 'QUOTED', 'BOOKED', 'ASSIGNED', 'SCHEDULED', 'IN_TRANSIT', 'REPORTED', 'UNDER_MAINTENANCE', 'CLOSING', 'ON_HOLD', 'IN_STORE'].includes(v)) return 'warning';
  if (['CANCELLED', 'REJECTED', 'NO_SHOW', 'OUT_OF_ORDER', 'FAILED', 'FAILED_INSPECTION', 'REVERSED', 'VOIDED', 'DAMAGED', 'LOST', 'DISPOSED', 'LOCKED', 'BLACKLISTED', 'OVERDUE', 'URGENT'].includes(v)) return 'destructive';
  if (['OCCUPIED', 'CHECKED_OUT', 'GUARANTEED', 'NEW', 'SERVED', 'REPLENISHMENT', 'DEPOSIT'].includes(v)) return 'info';
  return 'muted';
}
export const qs = (o: Record<string, any>) => { const p = new URLSearchParams(); Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); }); const s = p.toString(); return s ? `?${s}` : ''; };
export const nightsBetween = (a: string, b: string) => Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
