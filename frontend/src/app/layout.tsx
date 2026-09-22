import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
export const metadata: Metadata = { title: 'HMS — Hotel Management System', description: 'Integrated PMS, POS, Inventory & Accounting', manifest: '/manifest.webmanifest' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2563eb' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body><Providers>{children}</Providers></body></html>;
}
