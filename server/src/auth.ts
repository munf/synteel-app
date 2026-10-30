// Accounts for farmers: phone number + 6-digit PIN. No SMS or e-mail needed, which keeps
// it free and usable for older farmers; an owner can reset a worker's PIN.
import { tx } from './i18n.ts';
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429;
  /** For the app to tell cases apart: 'locked', 'phone_taken', 'invite_invalid'. */
  readonly code: string | undefined;
  /** With 'locked': when trying again is allowed (ISO). */
  readonly retryAt: string | undefined;
  constructor(message: string, status: 400 | 401 | 403 | 404 | 409 | 410 | 429 = 401, code?: string, retryAt?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAt = retryAt;
  }
}

/** "0812-3456 7890", "+62 812…" and "62812…" all become "628123456789". */
export function normalizePhone(input: unknown): string {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  else if (digits.startsWith('8')) digits = '62' + digits;
  if (!/^\d{10,15}$/.test(digits)) throw new AuthError(tx('Nomor HP tidak valid', 'Phone number is not valid'), 400);
  return digits;
}

/** Six digits, and not one anybody would guess first. */
export function checkPin(input: unknown): string {
  const pin = String(input ?? '');
  if (!/^\d{6}$/.test(pin)) throw new AuthError(tx('PIN harus 6 angka', 'The PIN must be 6 digits'), 400);
  const ascending = '0123456789012';
  const descending = '9876543210987';
  if (/^(\d)\1{5}$/.test(pin) || ascending.includes(pin) || descending.includes(pin)) {
    throw new AuthError(tx('PIN terlalu mudah ditebak. Pilih 6 angka lain.', 'That PIN is too easy to guess. Choose 6 other digits.'), 400);
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
export function attemptLimiter(max = 5, windowMs = 15 * 60_000, now = () => Date.now(), message = () => tx('Terlalu banyak percobaan. Coba lagi 15 menit lagi.', 'Too many tries. Try again in 15 minutes.')) {
  const fails = new Map<string, number[]>();
  const recent = (key: string) => (fails.get(key) ?? []).filter((t) => now() - t < windowMs);
  return {
    /** Refuses with 429 'locked' and the time the oldest counted try runs out. */
    check(...keys: string[]) {
      const full = keys.map(recent).filter((r) => r.length >= max);
      if (full.length) {
        const retryAt = Math.max(...full.map((r) => r[r.length - max] + windowMs));
        throw new AuthError(message(), 429, 'locked', new Date(retryAt).toISOString());
      }
    },
    fail(...keys: string[]) {
      for (const k of keys) fails.set(k, [...recent(k), now()]);
    },
    clear(...keys: string[]) {
      for (const k of keys) fails.delete(k);
    },
  };
}

/** "Fajar.N@Gmail.com " → "fajar.n@gmail.com"; null when it is not an e-mail address. */
export function normalizeEmail(input: unknown): string | null {
  const email = String(input ?? '').trim().toLowerCase();
  return email.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

/** "fajar.n@gmail.com" → "fa•••@gmail.com", to show where a code went without spelling out the address. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, Math.min(2, local.length - 1) || 1)}•••@${domain}`;
}

export type CodePurpose = 'register' | 'reset';

/**
 * Six-digit codes sent by e-mail for Daftar and Lupa PIN: one live code per purpose and phone number,
 * valid 15 minutes, gone after 5 wrong tries. In memory like the limiter: a restart only means asking again.
 */
export function emailCodes(now = () => Date.now(), validMs = 15 * 60_000, maxTries = 5) {
  const live = new Map<string, { email: string; hash: string; expires: number; tries: number }>();
  const key = (purpose: CodePurpose, phone: string) => `${purpose}:${phone}`;
  return {
    issue(purpose: CodePurpose, phone: string, email: string): string {
      const code = String(randomInt(1_000_000)).padStart(6, '0');
      live.set(key(purpose, phone), { email, hash: hashToken(code), expires: now() + validMs, tries: 0 });
      return code;
    },
    /** Throws a 400 'code_wrong' or 410 'code_expired'; a right code is used up. */
    use(purpose: CodePurpose, phone: string, email: string, input: unknown) {
      const k = key(purpose, phone);
      const entry = live.get(k);
      if (!entry || entry.email !== email || entry.expires <= now()) {
        live.delete(k);
        throw new AuthError(tx('Kode sudah tidak berlaku. Minta kode baru.', 'This code no longer works. Ask for a new code.'), 410, 'code_expired');
      }
      const code = String(input ?? '').replace(/\D/g, '');
      if (code.length !== 6 || !timingSafeEqual(Buffer.from(hashToken(code)), Buffer.from(entry.hash))) {
        entry.tries += 1;
        if (entry.tries >= maxTries) {
          live.delete(k);
          throw new AuthError(tx('Kode salah terlalu sering. Minta kode baru.', 'Wrong code too many times. Ask for a new code.'), 410, 'code_expired');
        }
        throw new AuthError(tx('Kode salah. Cek email yang paling baru.', 'Wrong code. Check the newest e-mail.'), 400, 'code_wrong');
      }
      live.delete(k);
    },
  };
}
