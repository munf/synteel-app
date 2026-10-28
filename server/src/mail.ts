// Support tickets by e-mail: a minimal SMTP client (RFC 5321) on node:net / node:tls, so the
// server needs no mail library for the few messages it sends. Implicit TLS on port 465;
// on 587 / 25 STARTTLS whenever the server offers it. AUTH LOGIN, UTF-8 subject and body.
import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string[];
  timeoutMs?: number;
}

export interface Mail {
  subject: string;
  text: string;
}

export type SendMail = (mail: Mail) => Promise<void>;

/** null when mail is not configured: tickets are then only stored. */
export function mailer(cfg: SmtpConfig | null): SendMail | null {
  return cfg ? (mail) => sendMail(cfg, mail) : null;
}

interface Reply {
  code: number;
  text: string;
}

/** Reads SMTP replies (multi-line ones end with "250 " instead of "250-") from one socket. */
function replies(socket: Socket) {
  let buf = '';
  let lines: string[] = [];
  const ready: Reply[] = [];
  let waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  let failed: Error | null = null;

  const onData = (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line.slice(4));
      if (line[3] === '-') continue;
      ready.push({ code: Number(line.slice(0, 3)), text: lines.join(' ') });
      lines = [];
    }
    if (waiting && ready.length) {
      waiting.resolve(ready.shift()!);
      waiting = null;
    }
  };
  const onEnd = (err?: Error) => {
    failed ??= err instanceof Error ? err : new Error('SMTP connection closed');
    waiting?.reject(failed);
    waiting = null;
  };
  const onClose = () => onEnd();
  socket.on('data', onData);
  socket.on('error', onEnd);
  socket.on('close', onClose);

  return {
    next(): Promise<Reply> {
      if (ready.length) return Promise.resolve(ready.shift()!);
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => (waiting = { resolve, reject }));
    },
    /** Stop reading this socket (before handing it to TLS). */
    detach() {
      socket.off('data', onData);
      socket.off('error', onEnd);
      socket.off('close', onClose);
    },
  };
}

/** The address inside "Synteel <help@synt.fun>", for the envelope. */
const address = (s: string) => s.match(/<([^>]+)>/)?.[1] ?? s.trim();

/** RFC 2047: non-ASCII header text as UTF-8 base64 encoded words, folded under 76 characters. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

/** A line starting with "." gets a second one, so it cannot end the DATA section early. */
export const dotStuff = (data: string) => data.replace(/(^|\r\n)\./g, '$1..');

export function buildMessage(cfg: Pick<SmtpConfig, 'from' | 'to'>, mail: Mail, date = new Date()): string {
  const domain = address(cfg.from).split('@')[1] ?? 'localhost';
  const body = Buffer.from(mail.text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    `From: ${cfg.from}`,
    `To: ${cfg.to.join(', ')}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || host.startsWith('127.');

function open(cfg: SmtpConfig): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      cfg.port === 465
        ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(socket))
        : netConnect({ host: cfg.host, port: cfg.port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

function upgrade(socket: Socket, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: host }, () => resolve(secure));
    secure.once('error', reject);
  });
}

/** Sends one message; rejects on any refusal, a dropped connection or after the timeout (15 s). */
export async function sendMail(cfg: SmtpConfig, mail: Mail): Promise<void> {
  let socket = await open(cfg);
  let tls = cfg.port === 465;
  const timer = setTimeout(() => socket.destroy(new Error('SMTP timeout')), cfg.timeoutMs ?? 15_000);
  try {
    let read = replies(socket);
    const expect = async (step: string, code: number) => {
      const reply = await read.next();
      if (reply.code !== code) throw new Error(`SMTP ${step}: ${reply.code} ${reply.text}`);
      return reply;
    };
    // `step` names the command in errors, so the AUTH lines (credentials) never get logged.
    const send = (step: string, line: string, code: number) => {
      socket.write(`${line}\r\n`);
      return expect(step, code);
    };

    await expect('greeting', 220);
    let ehlo = await send('EHLO', 'EHLO synteel', 250);
    if (!tls && /\bSTARTTLS\b/i.test(ehlo.text)) {
      await send('STARTTLS', 'STARTTLS', 220);
      read.detach();
      socket = await upgrade(socket, cfg.host);
      tls = true;
      read = replies(socket);
      ehlo = await send('EHLO', 'EHLO synteel', 250);
    }
    if (cfg.user) {
      if (!tls && !isLoopback(cfg.host)) throw new Error('SMTP: server offers no TLS; not sending the password in clear text');
      await send('AUTH', 'AUTH LOGIN', 334);
      await send('AUTH', Buffer.from(cfg.user).toString('base64'), 334);
      await send('AUTH', Buffer.from(cfg.pass).toString('base64'), 235);
    }
    await send('MAIL FROM', `MAIL FROM:<${address(cfg.from)}>`, 250);
    for (const to of cfg.to) await send('RCPT TO', `RCPT TO:<${address(to)}>`, 250);
    await send('DATA', 'DATA', 354);
    await send('message', `${dotStuff(buildMessage(cfg, mail))}\r\n.`, 250);
    socket.write('QUIT\r\n');
  } finally {
    clearTimeout(timer);
    socket.end();
  }
}
