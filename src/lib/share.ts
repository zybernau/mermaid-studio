import { deflate, inflate } from 'pako';

function toUrlSafeBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromUrlSafeBase64(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeShare(code: string): string {
  const bytes = new TextEncoder().encode(code);
  return toUrlSafeBase64(deflate(bytes, { level: 9 }));
}

export function decodeShare(hash: string): string | null {
  try {
    const bytes = fromUrlSafeBase64(hash);
    return new TextDecoder().decode(inflate(bytes));
  } catch {
    return null;
  }
}

export function readShareFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash;
  const m = h.match(/#c=([A-Za-z0-9\-_]+)/);
  if (!m) return null;
  return decodeShare(m[1]);
}

export function buildShareUrl(code: string): string {
  const encoded = encodeShare(code);
  const url = new URL(window.location.href);
  url.hash = `c=${encoded}`;
  return url.toString();
}
