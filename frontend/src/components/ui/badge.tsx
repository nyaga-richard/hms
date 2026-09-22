import * as React from 'react';
import { cn, statusTone, titleCase } from '@/lib/utils';
const tones: Record<string, string> = {
  default: 'bg-primary/10 text-primary border-primary/20', success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20', warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
  destructive: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20', info: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20', muted: 'bg-muted text-muted-foreground border-transparent', outline: 'border-border text-foreground',
};
export function Badge({ className, tone = 'default', children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', tones[tone], className)} {...props}>{children}</span>;
}
export function StatusBadge({ status, className }: { status?: string | null; className?: string }) { if (!status) return null; return <Badge tone={statusTone(status)} className={className}>{titleCase(status)}</Badge>; }
