import { Capacitor } from '@capacitor/core';
import { DataEncoding, TcpSocket } from 'capacitor-tcp-socket';
import type { ReceiptData } from '../components/Receipt';
import { rasterToEscPos } from './escpos';
import { fmt } from './format';

export interface PrinterConfig { ip: string; port: number; widthMm: 58 | 80 }
const KEY = 'bh_pos_printer';

export const printer = {
  get(): PrinterConfig | null {
    try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; }
  },
  set(c: PrinterConfig) { localStorage.setItem(KEY, JSON.stringify(c)); },
  clear() { localStorage.removeItem(KEY); },
};

// Network printing needs raw TCP, which only the native app has; the browser build falls back to window.print().
export const canPrintNative = () => Capacitor.isNativePlatform() && !!printer.get();

function drawReceipt(r: ReceiptData | { title: string }, width: number): HTMLCanvasElement {
  const rows: { l: string; r?: string; bold?: boolean; center?: boolean; rtl?: boolean }[] = [];
  if ('title' in r) rows.push({ l: r.title, center: true, bold: true }, { l: new Date().toLocaleString('en-GB'), center: true }, { l: 'Printer OK', center: true });
  else {
    rows.push({ l: r.seller.name, center: true, bold: true }, { l: r.seller.branch, center: true });
    if (r.seller.taxNumber) rows.push({ l: `Tax no. ${r.seller.taxNumber}`, center: true });
    rows.push({ l: r.provisional ? 'PROVISIONAL (sold offline)' : `Invoice ${r.invoiceNumber ?? ''}`, center: true }, { l: `${r.orderNumber} ${r.issuedAt ? new Date(r.issuedAt).toLocaleString('en-GB') : ''}`, center: true }, { l: '-'.repeat(40) });
    for (const x of r.lines) {
      rows.push({ l: `${x.qty} x ${x.name}`, r: fmt(x.total) });
      if (x.nameAr) rows.push({ l: x.nameAr, rtl: true });
      for (const m of x.modifiers ?? []) rows.push({ l: `  + ${m.name}` });
    }
    rows.push({ l: '-'.repeat(40) }, { l: 'Subtotal', r: fmt(r.subtotal) });
    if (Number(r.discount) > 0) rows.push({ l: 'Discount', r: `-${fmt(r.discount)}` });
    rows.push({ l: 'Total JOD', r: fmt(r.total), bold: true });
    for (const t of r.taxBreakdown) rows.push({ l: `Tax ${t.ratePct}% (net ${fmt(t.net)})`, r: fmt(t.tax) });
    rows.push({ l: '-'.repeat(40) });
    for (const t of r.tenders) rows.push({ l: `${t.method}${Number(t.change) > 0 ? ` (change ${fmt(t.change)})` : ''}`, r: fmt(t.tendered) });
  }
  const px = 24, lineH = 32;
  const c = document.createElement('canvas');
  c.width = width; c.height = rows.length * lineH + 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000'; g.textBaseline = 'middle';
  rows.forEach((row, i) => {
    const y = 8 + i * lineH + lineH / 2;
    g.font = `${row.bold ? 'bold ' : ''}${px}px monospace`;
    if (row.center) { g.textAlign = 'center'; g.fillText(row.l, width / 2, y); return; }
    if (row.rtl) { g.direction = 'rtl'; g.textAlign = 'right'; g.fillText(row.l, width - 4, y); g.direction = 'ltr'; return; }
    g.textAlign = 'left'; g.fillText(row.l.startsWith('---') ? '-'.repeat(Math.floor(width / (px * 0.6))) : row.l, 4, y);
    if (row.r) { g.textAlign = 'right'; g.fillText(row.r, width - 4, y); }
  });
  return c;
}

async function send(cfg: PrinterConfig, bytes: Uint8Array) {
  const { client } = await TcpSocket.connect({ ipAddress: cfg.ip, port: cfg.port });
  try {
    // chunked base64 so large receipts do not overrun the bridge or the printer buffer
    for (let i = 0; i < bytes.length; i += 4096) {
      let s = '';
      for (const b of bytes.subarray(i, i + 4096)) s += String.fromCharCode(b);
      await TcpSocket.send({ client, data: btoa(s), encoding: DataEncoding.BASE64 });
    }
  } finally {
    await TcpSocket.disconnect({ client }).catch(() => undefined);
  }
}

export async function printReceipt(r: ReceiptData | { title: string }) {
  const cfg = printer.get();
  if (!cfg) throw new Error('No printer configured');
  const width = cfg.widthMm === 58 ? 384 : 576;
  const c = drawReceipt(r, width);
  const img = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
  await send(cfg, rasterToEscPos(img.data, c.width, c.height));
}
