import { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodSchema } from 'zod';
import { BadRequest } from './errors';

export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export function validate<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new BadRequest('Validation failed: ' + issues.map((i) => `${i.path || 'body'}: ${i.message}`).join('; '), issues, 'VALIDATION_ERROR');
  }
  return r.data;
}

export interface Pagination { page: number; pageSize: number; offset: number; sort?: string; order: 'asc' | 'desc'; search?: string }

export function getPagination(req: Request, defaultSort = 'created_at', maxPageSize = 500): Pagination {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, parseInt(String(req.query.pageSize ?? '25'), 10) || 25));
  const sort = typeof req.query.sort === 'string' && /^[a-zA-Z0-9_.]+$/.test(req.query.sort) ? req.query.sort : defaultSort;
  const order = String(req.query.order ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim() : undefined;
  return { page, pageSize, offset: (page - 1) * pageSize, sort, order, search };
}

export function paged<T>(rows: T[], total: number, p: Pagination) {
  return { data: rows, total, page: p.page, pageSize: p.pageSize, pages: Math.ceil(total / p.pageSize) };
}

export const idParam = z.object({ id: z.string().uuid() });
export const uuid = z.string().uuid();
export const money = z.coerce.number().finite();
export const qty = z.coerce.number().finite();
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const optionalStr = z.string().trim().optional().nullable().transform((v) => (v === '' ? null : v ?? null));

export function toCsv(rows: Record<string, any>[], columns?: string[]): string {
  if (!rows.length) return '';
  const cols = columns ?? Object.keys(rows[0]);
  const esc = (v: any) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

export type ExportFormat = 'json' | 'csv' | 'xlsx' | 'pdf';
export const isExport = (req: Request) => ['csv', 'xlsx', 'pdf'].includes(String(req.query.format ?? 'json'));
/**
 * Send a report/list in the requested format (?format=json|csv|xlsx|pdf). All exports honour the same filters as the JSON list;
 * the caller has already applied RBAC. Column headers are derived from the row keys (snake_case → Title Case).
 */
export function sendExport(res: Response, req: Request, rows: Record<string, any>[], name: string, opts: { title?: string; columns?: string[]; meta?: Record<string, any> } = {}) {
  const format = String(req.query.format ?? 'json') as ExportFormat;
  const stamp = new Date().toISOString().slice(0, 10);
  const columns = opts.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const title = opts.title ?? name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const label = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const cell = (v: any) => v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : v;
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.csv"`);
    return res.send(toCsv(rows));
  }
  if (format === 'xlsx') {
    // Lazy require keeps startup fast and avoids loading exceljs for JSON requests
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'HMS'; wb.created = new Date();
    const ws = wb.addWorksheet(title.slice(0, 31));
    ws.addRow([title]).font = { bold: true, size: 14 };
    ws.addRow([`Generated ${new Date().toISOString()}${opts.meta ? '  ' + Object.entries(opts.meta).map(([k, v]) => `${label(k)}: ${v}`).join('  |  ') : ''}`]);
    ws.addRow([]);
    const header = ws.addRow(columns.map(label)); header.font = { bold: true }; header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    rows.forEach((r) => ws.addRow(columns.map((c) => { const v = cell(r[c]); const n = typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v; return n; })));
    ws.columns.forEach((col: any) => { let w = 10; col.eachCell?.({ includeEmpty: false }, (c: any) => { w = Math.max(w, Math.min(50, String(c.value ?? '').length + 2)); }); col.width = w; });
    ws.views = [{ state: 'frozen', ySplit: 4 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.xlsx"`);
    return wb.xlsx.write(res).then(() => res.end());
  }
  if (format === 'pdf') {
    const PDFDocument = require('pdfkit');
    const landscape = columns.length > 6;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, info: { Title: title, Author: 'HMS' } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.pdf"`);
    doc.pipe(res);
    const pageW = doc.page.width - 72;
    doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'left' });
    doc.fontSize(8).font('Helvetica').fillColor('#555').text(`Generated ${new Date().toLocaleString()}${opts.meta ? '   ' + Object.entries(opts.meta).map(([k, v]) => `${label(k)}: ${v}`).join('   ') : ''}   Rows: ${rows.length}`);
    doc.moveDown(0.8).fillColor('#000');
    const colW = pageW / Math.max(1, columns.length);
    const fontSize = columns.length > 10 ? 6 : columns.length > 7 ? 7 : 8;
    const drawHeader = () => {
      const y = doc.y; doc.rect(36, y - 2, pageW, fontSize + 8).fill('#E5E7EB').fillColor('#000');
      doc.font('Helvetica-Bold').fontSize(fontSize);
      columns.forEach((c, i) => doc.text(label(c), 38 + i * colW, y + 2, { width: colW - 4, ellipsis: true, lineBreak: false }));
      doc.y = y + fontSize + 10; doc.font('Helvetica');
    };
    drawHeader();
    rows.forEach((r, idx) => {
      if (doc.y > doc.page.height - 50) { doc.addPage(); drawHeader(); }
      const y = doc.y;
      if (idx % 2 === 1) { doc.rect(36, y - 2, pageW, fontSize + 6).fill('#F9FAFB').fillColor('#000'); }
      columns.forEach((c, i) => { const v = cell(r[c]); const num = typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)); doc.fontSize(fontSize).text(num ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v), 38 + i * colW, y, { width: colW - 4, ellipsis: true, lineBreak: false, align: num ? 'right' : 'left' }); });
      doc.y = y + fontSize + 6;
    });
    doc.end();
    return;
  }
  return res.json({ data: rows, ...(opts.meta ? { meta: opts.meta } : {}) });
}

export function clientIp(req: Request): string | undefined {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string') return xf.split(',')[0].trim();
  return req.socket?.remoteAddress ?? undefined;
}

/** Normalise a DATE/TIMESTAMP value (string or Date) to 'YYYY-MM-DD'. */
export function ymd(v: string | Date | null | undefined): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
/** Add n days to a 'YYYY-MM-DD' string. */
export function addDays(d: string, n: number): string {
  const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
}
