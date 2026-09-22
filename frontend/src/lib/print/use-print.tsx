'use client';
import React, { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Printer, ChevronDown, Check, RotateCcw, FileSearch } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { Button, type ButtonProps } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { cn } from '@/lib/utils';
import { PAPERS, PAPER_ORDER, devicePaper, isRoll, printHtml, previewHtml, renderToHtml, resolvePaper, type DocType, type Paper } from './engine';
import type { DocCtx, PrintProperty } from './templates';

export interface PrintProfile { property: PrintProperty | null; settings: Record<string, any> }

/** Letterhead + `print.*` settings for the active property (cached; readable by every authenticated user). */
export function usePrintProfile() {
  const { data } = useApi<PrintProfile>('/print/profile', undefined, { staleTime: 5 * 60_000 });
  return data ?? null;
}

export interface PrintJob {
  doc: DocType;
  title: string;
  /** Build the document for the resolved paper. May be async (e.g. to fetch data or encode a QR code). */
  render: (ctx: DocCtx) => ReactElement | Promise<ReactElement>;
  paper?: Paper;
  copies?: number;
  /** Open in a new tab (preview / save as PDF) instead of printing straight away. */
  preview?: boolean;
}

/** `print(job)` renders and prints; `paperFor(doc)` tells what paper a document type will use on this device. */
export function usePrinter() {
  const profile = usePrintProfile();
  const { currency, user } = useAuth();
  const [busy, setBusy] = useState(false);
  const paperFor = useCallback((doc: DocType) => resolvePaper(doc, profile?.settings), [profile]);
  const print = useCallback(async (job: PrintJob) => {
    const paper = job.paper ?? resolvePaper(job.doc, profile?.settings);
    const ctx: DocCtx = { paper, roll: isRoll(paper), property: profile?.property ?? null, settings: profile?.settings ?? {}, currency: profile?.property?.currency || currency, now: new Date(), user: user?.full_name ?? user?.username ?? null };
    setBusy(true);
    try {
      const el = await job.render(ctx);
      const bodyHtml = renderToHtml(el);
      const copies = job.copies ?? (job.doc === 'receipt' ? Number(profile?.settings?.['print.receipt_copies'] ?? 1) : 1);
      if (job.preview) previewHtml({ title: job.title, bodyHtml, paper, copies });
      else await printHtml({ title: job.title, bodyHtml, paper, copies });
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not prepare the document for printing');
    } finally { setBusy(false); }
  }, [profile, currency, user]);
  return { print, paperFor, busy, profile };
}

interface PrintButtonProps extends Omit<ButtonProps, 'onClick' | 'title'> {
  doc: DocType;
  title: string;
  render: PrintJob['render'];
  label?: React.ReactNode;
  copies?: number;
  /** Restrict the paper choices offered in the menu (defaults to all). */
  papers?: Paper[];
  /** Hide the paper-chooser half (plain button). */
  simple?: boolean;
  onPrinted?: () => void;
}

/**
 * Print split-button: the main part prints on the paper resolved for this document type (device override →
 * hotel setting → default); the chevron opens the paper menu — choosing a paper prints on it and remembers it
 * for this document type on this device.
 */
export function PrintButton({ doc, title, render, label = 'Print', copies, papers = PAPER_ORDER, simple, onPrinted, className, variant = 'outline', size, disabled, ...rest }: PrintButtonProps) {
  const { print, paperFor, busy } = usePrinter();
  const [, bump] = useState(0);
  const current = paperFor(doc);
  const overridden = devicePaper.get(doc) != null;
  const run = async (paper?: Paper, preview?: boolean) => { await print({ doc, title, render, paper, copies, preview }); onPrinted?.(); };
  const choose = (paper: Paper) => { devicePaper.set(doc, paper); bump((x) => x + 1); void run(paper); };
  const reset = () => { devicePaper.set(doc, null); bump((x) => x + 1); };
  const iconOnly = size === 'icon';
  const main = <Button type="button" variant={variant} size={size} disabled={disabled || busy} loading={busy} title={`Print on ${PAPERS[current].label}`} className={cn(!simple && !iconOnly && 'rounded-r-none border-r-0', className)} onClick={() => void run()} {...rest}>
    {!busy && <Printer />}{!iconOnly && <>{label}<span className="ml-1 rounded bg-foreground/10 px-1 text-[10px] font-normal tabular-nums">{PAPERS[current].short}</span></>}
  </Button>;
  if (simple || iconOnly) return main;
  return <span className="inline-flex">
    {main}
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button type="button" variant={variant} size={size} disabled={disabled || busy} className="rounded-l-none px-1.5" aria-label="Choose paper"><ChevronDown className="h-4 w-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuLabel>Print on…</DropdownMenuLabel>
        {papers.map((p) => <DropdownMenuItem key={p} onSelect={() => choose(p)}><span className="w-4">{p === current && <Check className="h-4 w-4" />}</span>{PAPERS[p].label}</DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void run(undefined, true)}><FileSearch />Preview / save as PDF</DropdownMenuItem>
        {overridden && <DropdownMenuItem onSelect={reset}><RotateCcw />Use hotel default</DropdownMenuItem>}
        <div className="px-2 py-1 text-[10px] text-muted-foreground">Choice is remembered on this device.</div>
      </DropdownMenuContent>
    </DropdownMenu>
  </span>;
}

/** Convenience for pages that only need a paper label. */
export function usePaperLabel(doc: DocType) { const { paperFor } = usePrinter(); return useMemo(() => PAPERS[paperFor(doc)].label, [paperFor, doc]); }
