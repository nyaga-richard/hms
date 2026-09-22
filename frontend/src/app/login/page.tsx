'use client';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
export default function LoginPage() {
  const { login, user } = useAuth(); const router = useRouter();
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [show, setShow] = useState(false); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  React.useEffect(() => { if (user) router.replace('/'); }, [user, router]);
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await login(username.trim(), password); router.replace('/'); } catch (e: any) { setErr(e.message ?? 'Login failed'); } finally { setBusy(false); } };
  return <div className="min-h-screen grid lg:grid-cols-2">
    <div className="hidden lg:flex flex-col justify-between bg-gradient-to-br from-primary to-blue-900 text-primary-foreground p-10">
      <div className="flex items-center gap-2 font-semibold"><Building2 className="h-6 w-6" />HMS</div>
      <div><h2 className="text-3xl font-semibold leading-tight">One integrated system for the whole property.</h2><p className="mt-3 text-primary-foreground/80 max-w-md">Front office, housekeeping, restaurants & bars, inventory, procurement and accounting — every transaction flows into one ledger with a complete audit trail.</p></div>
      <div className="text-xs text-primary-foreground/60">Master data → Request → Approval → Transaction → Ledger → Reporting</div>
    </div>
    <div className="flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div><div className="lg:hidden flex items-center gap-2 font-semibold mb-6"><Building2 className="h-6 w-6 text-primary" />HMS</div><h1 className="text-2xl font-semibold">Sign in</h1><p className="text-sm text-muted-foreground">Use your staff credentials</p></div>
        <div className="space-y-1.5"><Label htmlFor="u">Username</Label><Input id="u" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required className="h-10" /></div>
        <div className="space-y-1.5"><Label htmlFor="p">Password</Label><div className="relative"><Input id="p" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-10 pr-10" /><button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-2.5 text-muted-foreground" aria-label="Toggle password">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></div>
        {err && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</div>}
        <Button type="submit" className="w-full h-10" loading={busy}>Sign in</Button>
        <p className="text-xs text-muted-foreground text-center">Demo: admin / gm / fom / reception / restaurant / storekeeper / accountant — password <code>Password123</code></p>
      </form>
    </div>
  </div>;
}
