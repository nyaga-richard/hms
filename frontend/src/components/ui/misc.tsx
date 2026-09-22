'use client';
import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, Inbox, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root className={cn('peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input', className)} {...props} ref={ref}>
    <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
export const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root ref={ref} className={cn('peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground', className)} {...props}>
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current"><Check className="h-3.5 w-3.5" /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';
export const TooltipProvider = TooltipPrimitive.Provider;
export function Tip({ content, children, side = 'top' }: { content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return <TooltipPrimitive.Root delayDuration={200}><TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger><TooltipPrimitive.Portal><TooltipPrimitive.Content side={side} sideOffset={4} className="z-50 overflow-hidden rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md animate-in fade-in-0 zoom-in-95">{content}</TooltipPrimitive.Content></TooltipPrimitive.Portal></TooltipPrimitive.Root>;
}
export const Popover = PopoverPrimitive.Root; export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverContent = React.forwardRef<React.ElementRef<typeof PopoverPrimitive.Content>, React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal><PopoverPrimitive.Content ref={ref} align={align} sideOffset={sideOffset} className={cn('z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0', className)} {...props} /></PopoverPrimitive.Portal>
));
PopoverContent.displayName = 'PopoverContent';
export function Spinner({ className }: { className?: string }) { return <div className={cn('flex items-center justify-center p-8 text-muted-foreground', className)}><Loader2 className="h-5 w-5 animate-spin" /></div>; }
export function Empty({ title = 'Nothing here yet', hint, icon: Icon = Inbox, action }: { title?: string; hint?: string; icon?: any; action?: React.ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground"><Icon className="h-8 w-8 opacity-40" /><div className="text-sm font-medium text-foreground">{title}</div>{hint && <div className="text-xs max-w-sm">{hint}</div>}{action}</div>;
}
export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) { return <div className={cn('shrink-0 bg-border', vertical ? 'w-px h-full' : 'h-px w-full', className)} />; }
export function Skeleton({ className }: { className?: string }) { return <div className={cn('animate-pulse rounded-md bg-muted', className)} />; }
export function Kbd({ children }: { children: React.ReactNode }) { return <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">{children}</kbd>; }
export function Stat({ label, value, sub, tone, icon: Icon, onClick }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'default' | 'success' | 'warning' | 'destructive' | 'info'; icon?: any; onClick?: () => void }) {
  const t = { default: 'text-foreground', success: 'text-emerald-600 dark:text-emerald-400', warning: 'text-amber-600 dark:text-amber-400', destructive: 'text-red-600 dark:text-red-400', info: 'text-sky-600 dark:text-sky-400' }[tone ?? 'default'];
  return <div onClick={onClick} className={cn('rounded-lg border bg-card p-3 flex flex-col gap-1 min-w-0', onClick && 'cursor-pointer hover:bg-accent/50 transition-colors')}><div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide text-muted-foreground"><span className="truncate">{label}</span>{Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}</div><div className={cn('text-xl font-semibold tabular truncate', t)}>{value}</div>{sub && <div className="text-xs text-muted-foreground truncate">{sub}</div>}</div>;
}
