'use client';
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** Real, scanner-readable QR code as an SVG string (for print templates). */
export async function qrSvg(value: string, opts: { margin?: number; ecl?: 'L' | 'M' | 'Q' | 'H' } = {}): Promise<string> {
  const svg = await QRCode.toString(value, { type: 'svg', margin: opts.margin ?? 0, errorCorrectionLevel: opts.ecl ?? 'M' });
  // make it scale with its container
  return svg.replace('<svg ', '<svg style="width:100%;height:auto;display:block" ');
}

/** On-screen QR code (renders the same encoding the printed ticket uses). */
export function QRCodeView({ value, size = 168, className }: { value: string; size?: number; className?: string }) {
  const [svg, setSvg] = useState<string>('');
  useEffect(() => { let alive = true; qrSvg(value).then((s) => { if (alive) setSvg(s); }).catch(() => setSvg('')); return () => { alive = false; }; }, [value]);
  return <div className={className} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
