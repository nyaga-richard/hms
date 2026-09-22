'use client';
import React from 'react';
import { useAuth } from '@/lib/auth';
import { AppShell } from '@/components/shell/shell';
import { Spinner } from '@/components/ui/misc';
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading || !user) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>;
  return <AppShell>{children}</AppShell>;
}
