'use client';
import React from 'react';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import { QueryProvider } from '@/lib/query';
import { AuthProvider } from '@/lib/auth';
import { TooltipProvider } from '@/components/ui/misc';
export function Providers({ children }: { children: React.ReactNode }) {
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem><QueryProvider><AuthProvider><TooltipProvider>{children}</TooltipProvider><Toaster richColors position="top-right" closeButton /></AuthProvider></QueryProvider></ThemeProvider>;
}
