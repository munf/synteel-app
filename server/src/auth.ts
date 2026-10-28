// Accounts for farmers: phone number + 6-digit PIN. No SMS or e-mail needed, which keeps
// it free and usable for older farmers; an owner can reset a worker's PIN.
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  readonly status: 400 | 401 | 403 | 409 | 429;
  constructor(message: string, status: 400 | 401 | 403 | 409 | 429 = 401) {
    super(message);
    this.status = status;
  }
}

/** "0812-3456 7890", "+62 812…" and "62812…" all become "628123456789". */
export function normalizePhone(input: unknown): string {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  else if (digits.startsWith('8')) digits = '62' + digits;
  if (!/^\d{10,15}$/.test(digits)) throw new AuthError('Nomor HP tidak valid', 400);
  return digits;
}

/** Six digits, and not one anybody would guess first. */
export function checkPin(input: unknown): string {
  const pin = String(input ?? '');
  if (!/^\d{6}$/.test(pin)) throw new AuthError('PIN harus 6 angka', 400);
  const ascending = '0123456789012';
  const descending = '9876543210987';
  if (/^(\d)\1{5}$/.test(pin) || ascending.includes(pin) || descending.includes(pin)) {
    throw new AuthError('PIN terlalu mudah ditebak. Pilih 6 angka lain.', 400);
  }
  return pin;
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(pin, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Short codes an owner reads out or sends on WhatsApp; no 0/O or 1/I to mix up. */
export function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

/** A temporary PIN an owner gives a worker who forgot theirs. */
export function tempPin(): string {
  for (;;) {
    const pin = String(randomInt(1_000_000)).padStart(6, '0');
    try {
      return checkPin(pin);
    } catch {
      // drew an easy one; draw again
    }
  }
}

/**
 * Slows down PIN guessing: after 5 wrong tries for a phone number (or from one address),
 * further tries are refused for 15 minutes. In memory: a restart clears it, which is fine
 * for a single small server.
 */
export function attemptLimiter(max = 5, windowMs = 15 * 60_000, now = () => Date.now()) {
  const fails = new Map<string, number[]>();
  const recent = (key: string) => (fails.get(key) ?? []).filter((t) => now() - t < windowMs);
  return {
    check(...keys: string[]) {
      if (keys.some((k) => recent(k).length >= max)) throw new AuthError('Terlalu banyak percobaan. Coba lagi 15 menit lagi.', 429);
    },
    fail(...keys: string[]) {
      for (const k of keys) fails.set(k, [...recent(k), now()]);
    },
    clear(...keys: string[]) {
      for (const k of keys) fails.delete(k);
    },
  };
}
