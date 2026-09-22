'use client';
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { api, tokenStore } from './api';

export interface AuthUser { id: string; username: string; full_name: string; email?: string; department_id?: string | null; roles: { id?: string; code?: string; name: string }[] | string[]; permissions: string[]; is_superuser: boolean; properties?: { id: string; code: string; name: string }[]; limits?: Record<string, number>; must_change_password?: boolean }
export interface Property { id: string; code: string; name: string; base_currency?: string; currency?: string }
interface Ctx { user: AuthUser | null; loading: boolean; properties: Property[]; property: Property | null; setProperty: (id: string) => void; login: (u: string, p: string) => Promise<AuthUser>; logout: () => Promise<void>; can: (...codes: string[]) => boolean; refresh: () => Promise<void>; currency: string }
const AuthCtx = createContext<Ctx>(null as any);
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter(); const pathname = usePathname();
  const load = useCallback(async () => {
    if (!tokenStore.get()) { setUser(null); setLoading(false); return; }
    try {
      const me = await api<any>('/auth/me');
      const u: AuthUser = me.user ?? me;
      setUser(u);
      let props: Property[] = u.properties ?? [];
      if (!props.length) { try { const r = await api<any>('/properties', { query: { pageSize: 50 } }); props = r.data ?? r; } catch { props = []; } }
      setProperties(props);
      const saved = tokenStore.getProperty();
      const pid = saved && props.some((p) => p.id === saved) ? saved : props[0]?.id ?? null;
      setPropertyId(pid); tokenStore.setProperty(pid);
    } catch { setUser(null); tokenStore.set(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const onLogout = () => { setUser(null); router.replace('/login'); }; window.addEventListener('hms:logout', onLogout); return () => window.removeEventListener('hms:logout', onLogout); }, [load, router]);
  useEffect(() => { if (!loading && !user && pathname !== '/login') router.replace('/login'); }, [loading, user, pathname, router]);
  const login = async (username: string, password: string) => { const r = await api<any>('/auth/login', { method: 'POST', body: { username, password } }); tokenStore.set(r.token); await load(); return r.user; };
  const logout = async () => { try { await api('/auth/logout', { method: 'POST', body: {} }); } catch {} tokenStore.set(null); setUser(null); router.replace('/login'); };
  const can = useCallback((...codes: string[]) => { if (!user) return false; if (user.is_superuser) return true; const set = new Set(user.permissions ?? []); return codes.length === 0 || codes.some((c) => set.has(c)); }, [user]);
  const property = properties.find((p) => p.id === propertyId) ?? null;
  const value = useMemo<Ctx>(() => ({ user, loading, properties, property, setProperty: (id) => { tokenStore.setProperty(id); setPropertyId(id); window.location.reload(); }, login, logout, can, refresh: load, currency: property?.base_currency ?? property?.currency ?? 'KES' }), [user, loading, properties, property, can, load]); // eslint-disable-line react-hooks/exhaustive-deps
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);
