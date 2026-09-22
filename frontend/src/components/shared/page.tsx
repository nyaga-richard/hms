'use client';
import React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
export function PageHeader({ title, subtitle, actions, crumbs, className }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; crumbs?: { label: string; href?: string }[]; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between mb-4', className)}>
      <div className="min-w-0">
        {crumbs && crumbs.length > 0 && <nav className="flex items-center gap-1 text-xs text-muted-foreground mb-1 flex-wrap">{crumbs.map((c, i) => <React.Fragment key={i}>{i > 0 && <ChevronRight className="h-3 w-3" />}{c.href ? <Link href={c.href} className="hover:text-foreground">{c.label}</Link> : <span>{c.label}</span>}</React.Fragment>)}</nav>}
        <h1 className="text-xl font-semibold tracking-tight truncate">{title}</h1>
        {subtitle && <div className="text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 no-print">{actions}</div>}
    </div>
  );
}
export function Section({ title, children, actions, className, description }: { title?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode; className?: string; description?: React.ReactNode }) {
  return <section className={cn('rounded-lg border bg-card', className)}>{(title || actions) && <header className="flex items-center justify-between gap-2 px-4 py-2.5 border-b"><div><h2 className="text-sm font-semibold">{title}</h2>{description && <p className="text-xs text-muted-foreground">{description}</p>}</div>{actions}</header>}<div className="p-4">{children}</div></section>;
}
type KVItem = { label: string; value: React.ReactNode; hide?: boolean } | [string, React.ReactNode];
export function KV({ items: raw, cols = 2, className }: { items: KVItem[]; cols?: 1 | 2 | 3 | 4; className?: string }) {
  const items = raw.map((i) => (Array.isArray(i) ? { label: i[0], value: i[1] } : i));
  return <dl className={cn('grid gap-x-4 gap-y-2 text-sm', { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-2 md:grid-cols-3', 4: 'grid-cols-2 md:grid-cols-4' }[cols], className)}>{items.filter((i) => !i.hide).map((i, idx) => <div key={idx} className="min-w-0"><dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{i.label}</dt><dd className="font-medium truncate">{i.value ?? '—'}</dd></div>)}</dl>;
}
