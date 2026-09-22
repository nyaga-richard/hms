'use client';
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Bell, ChevronDown, LogOut, Menu, Moon, Search, Sun, Building2, KeyRound, UserCircle2, Check, X } from 'lucide-react';
import { Command } from 'cmdk';
import { NAV, type NavItem } from '@/lib/nav';
import { useAuth } from '@/lib/auth';
import { useApi, useAction } from '@/lib/query';
import { get, post } from '@/lib/api';
import { cn, initials, fmtDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger, Kbd } from '@/components/ui/misc';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

function useVisibleNav() { const { can } = useAuth(); return useMemo(() => NAV.map((n) => ({ ...n, children: n.children?.filter((c) => !c.perms || can(...c.perms)) })).filter((n) => (!n.perms || can(...n.perms)) && (!n.children || n.children.length > 0 || !NAV.find((x) => x.href === n.href)?.children)), [can]); }
function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname(); const items = useVisibleNav();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => { const active = items.find((n) => n.href !== '/' && pathname.startsWith(n.href)); if (active) setOpen((o) => ({ ...o, [active.href]: true })); }, [pathname, items]);
  const isActive = (n: NavItem) => (n.href === '/' ? pathname === '/' : pathname === n.href || (pathname.startsWith(n.href + '/') && !items.some((o) => o.href !== n.href && o.href.length > n.href.length && pathname.startsWith(o.href))));
  return <nav className="flex flex-col gap-0.5 p-2 text-sm">
    {items.map((n) => { const Icon = n.icon; const active = isActive(n); const hasKids = !!n.children?.length; const expanded = open[n.href] ?? active;
      return <div key={n.href}>
        <div className={cn('flex items-center rounded-md', active && !hasKids && 'bg-primary/10 text-primary font-medium')}>
          <Link href={n.href} onClick={onNavigate} className={cn('flex flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent min-w-0', active && 'text-primary font-medium')}>{Icon && <Icon className="h-4 w-4 shrink-0" />}<span className="truncate">{n.label}</span></Link>
          {hasKids && <button aria-label="Toggle" onClick={() => setOpen((o) => ({ ...o, [n.href]: !expanded }))} className="p-2 text-muted-foreground hover:text-foreground"><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} /></button>}
        </div>
        {hasKids && expanded && <div className="ml-4 mt-0.5 mb-1 flex flex-col gap-0.5 border-l pl-2">{n.children!.map((c) => { const a = pathname === c.href; return <Link key={c.href + c.label} href={c.href} onClick={onNavigate} className={cn('rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground truncate', a && 'bg-primary/10 text-primary font-medium')}>{c.label}</Link>; })}</div>}
      </div>; })}
  </nav>;
}
function GlobalSearch() {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const [results, setResults] = useState<any[]>([]); const router = useRouter(); const nav = useVisibleNav();
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
  useEffect(() => { if (!open) { setQ(''); setResults([]); return; } if (q.trim().length < 2) { setResults([]); return; } const ctrl = new AbortController(); const t = setTimeout(() => { get('/search', { q }).then((r) => setResults(r.results ?? [])).catch(() => {}); }, 250); return () => { clearTimeout(t); ctrl.abort(); }; }, [q, open]);
  const pages = useMemo(() => nav.flatMap((n) => [{ label: n.label, href: n.href }, ...(n.children ?? []).map((c) => ({ label: `${n.label} › ${c.label}`, href: c.href }))]), [nav]);
  const go = (href: string) => { setOpen(false); router.push(href); };
  return <>
    <Button variant="outline" className="h-8 w-8 sm:w-56 justify-start gap-2 px-2 text-muted-foreground" onClick={() => setOpen(true)} aria-label="Search"><Search className="h-4 w-4" /><span className="hidden sm:inline text-xs flex-1 text-left">Search guests, rooms, orders…</span><Kbd>⌘K</Kbd></Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="p-0 gap-0 overflow-hidden" size="lg">
      <DialogHeader className="sr-only"><DialogTitle>Global search</DialogTitle></DialogHeader>
      <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground">
        <div className="flex items-center border-b px-3"><Search className="h-4 w-4 text-muted-foreground" /><Command.Input value={q} onValueChange={setQ} placeholder="Type a guest name, room, reservation or order number…" className="h-11 w-full bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground" autoFocus /></div>
        <Command.List className="max-h-[60vh] overflow-y-auto p-1">
          <Command.Empty className="py-6 text-center text-sm text-muted-foreground">{q.length < 2 ? 'Start typing to search across the system' : 'No results'}</Command.Empty>
          {results.length > 0 && <Command.Group heading="Records">{results.map((r, i) => <Command.Item key={r.type + r.id + i} value={r.type + r.id} onSelect={() => go(r.link)} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm aria-selected:bg-accent"><Badge tone="muted" className="w-24 justify-center capitalize">{r.type.replace('_', ' ')}</Badge><div className="min-w-0"><div className="truncate font-medium">{r.title}</div><div className="truncate text-xs text-muted-foreground">{r.subtitle}</div></div></Command.Item>)}</Command.Group>}
          {q.length >= 2 && <Command.Group heading="Pages">{pages.filter((p) => p.label.toLowerCase().includes(q.toLowerCase())).slice(0, 8).map((p) => <Command.Item key={p.href + p.label} value={p.href} onSelect={() => go(p.href)} className="cursor-pointer rounded-md px-3 py-2 text-sm aria-selected:bg-accent">{p.label}</Command.Item>)}</Command.Group>}
        </Command.List>
      </Command>
    </DialogContent></Dialog>
  </>;
}
function Notifications() {
  const { data, refetch } = useApi<any>('/notifications', { pageSize: 15 }, { refetchInterval: 30000 } as any);
  const rows: any[] = data?.data ?? []; const unread = data?.unread ?? rows.filter((n) => !n.read_at).length; const router = useRouter();
  const markAll = useAction(() => post('/notifications/read', {}), { silent: true, onSuccess: () => refetch() });
  const markOne = useAction((id: string) => post('/notifications/read', { ids: [id] }), { silent: true, onSuccess: () => refetch() });
  return <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" className="relative h-8 w-8" aria-label="Notifications"><Bell className="h-4 w-4" />{unread > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">{unread > 99 ? '99+' : unread}</span>}</Button></PopoverTrigger>
    <PopoverContent align="end" className="w-80 p-0"><div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">Notifications{unread > 0 && <Button variant="ghost" size="sm" onClick={() => markAll.mutate(undefined)}><Check className="h-3.5 w-3.5" />Mark all read</Button>}</div>
      <div className="max-h-96 overflow-y-auto">{rows.length === 0 ? <div className="p-6 text-center text-xs text-muted-foreground">You're all caught up</div> : rows.map((n) => <button key={n.id} onClick={() => { if (!n.read_at) markOne.mutate(n.id); if (n.link) router.push(n.link); }} className={cn('flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left hover:bg-accent', !n.read_at && 'bg-primary/5')}><div className="flex items-center gap-2"><span className={cn('h-1.5 w-1.5 rounded-full', n.severity === 'CRITICAL' || n.severity === 'HIGH' ? 'bg-destructive' : n.severity === 'WARNING' ? 'bg-warning' : 'bg-primary', n.read_at && 'opacity-0')} /><span className="text-sm font-medium truncate flex-1">{n.title}</span></div>{n.body && <div className="text-xs text-muted-foreground line-clamp-2">{n.body}</div>}<div className="text-[10px] text-muted-foreground">{fmtDateTime(n.created_at)}</div></button>)}</div>
    </PopoverContent></Popover>;
}
function ChangePassword({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [cur, setCur] = useState(''); const [nw, setNw] = useState(''); const [cf, setCf] = useState('');
  const m = useAction(() => post('/auth/change-password', { currentPassword: cur, newPassword: nw }), { success: 'Password changed', onSuccess: () => onOpenChange(false) });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent size="sm"><DialogHeader><DialogTitle>Change password</DialogTitle></DialogHeader><form onSubmit={(e) => { e.preventDefault(); if (nw !== cf) return; m.mutate(undefined); }} className="space-y-3"><Input type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} required /><Input type="password" placeholder="New password (min 8 chars)" value={nw} onChange={(e) => setNw(e.target.value)} minLength={8} required /><Input type="password" placeholder="Confirm new password" value={cf} onChange={(e) => setCf(e.target.value)} required />{nw && cf && nw !== cf && <p className="text-xs text-destructive">Passwords do not match</p>}<Button type="submit" className="w-full" loading={m.isPending}>Update password</Button></form></DialogContent></Dialog>;
}
export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, property, properties, setProperty, logout } = useAuth(); const { theme, setTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false); const [pw, setPw] = useState(false);
  const pathname = usePathname();
  useEffect(() => { setMobileOpen(false); }, [pathname]);
  const roleNames = (user?.roles ?? []).map((r: any) => (typeof r === 'string' ? r : r.name)).join(', ');
  return <div className="flex min-h-screen">
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r bg-card sticky top-0 h-screen">
      <div className="flex h-14 items-center gap-2 border-b px-4"><div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold">H</div><div className="min-w-0"><div className="text-sm font-semibold leading-tight truncate">{property?.name ?? 'HMS'}</div><div className="text-[10px] text-muted-foreground uppercase tracking-wide">Hotel ERP</div></div></div>
      <div className="flex-1 overflow-y-auto"><NavLinks /></div>
    </aside>
    {mobileOpen && <div className="fixed inset-0 z-40 lg:hidden"><div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} /><aside className="absolute left-0 top-0 h-full w-72 bg-card border-r shadow-xl flex flex-col"><div className="flex h-14 items-center justify-between border-b px-4"><span className="font-semibold">{property?.name ?? 'HMS'}</span><Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X className="h-4 w-4" /></Button></div><div className="flex-1 overflow-y-auto"><NavLinks onNavigate={() => setMobileOpen(false)} /></div></aside></div>}
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 backdrop-blur px-3 sm:px-4 no-print">
        <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></Button>
        <GlobalSearch />
        <div className="ml-auto flex items-center gap-1">
          {properties.length > 1 && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="gap-1.5 hidden sm:flex"><Building2 className="h-4 w-4" /><span className="max-w-[140px] truncate">{property?.name}</span><ChevronDown className="h-3 w-3" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>Switch property</DropdownMenuLabel>{properties.map((p) => <DropdownMenuItem key={p.id} onClick={() => setProperty(p.id)}>{p.id === property?.id && <Check className="h-3.5 w-3.5" />}{p.name}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme"><Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" /><Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" /></Button>
          <Notifications />
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="h-8 gap-2 px-1.5"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{initials(user?.full_name)}</span><span className="hidden md:block text-left leading-tight"><span className="block text-xs font-medium">{user?.full_name}</span><span className="block text-[10px] text-muted-foreground truncate max-w-[140px]">{roleNames}</span></span></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56"><DropdownMenuLabel className="font-normal"><div className="text-sm font-medium text-foreground">{user?.full_name}</div><div className="text-xs">@{user?.username}</div></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onClick={() => setPw(true)}><KeyRound />Change password</DropdownMenuItem><DropdownMenuItem asChild><Link href="/profile"><UserCircle2 />My profile & sessions</Link></DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem destructive onClick={() => logout()}><LogOut />Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        </div>
      </header>
      <main className="flex-1 p-3 sm:p-5 max-w-[1600px] w-full mx-auto">{children}</main>
    </div>
    <ChangePassword open={pw} onOpenChange={setPw} />
  </div>;
}
