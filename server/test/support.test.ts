import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { buildMessage, dotStuff, encodeHeader, mailer, sendMail, type Mail } from '../src/mail.ts';
import { farmWithWorker, server } from './helpers.ts';

/** A tiny SMTP server that accepts one message and records the whole conversation. */
async function fakeSmtp({ greet = true } = {}) {
  const got = { commands: [] as string[], data: '', done: null as null | (() => void) };
  const delivered = new Promise<void>((resolve) => (got.done = resolve));
  const srv = createServer((sock) => {
    let buf = '';
    let inData = false;
    if (greet) sock.write('220 fake.test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        got.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        sock.write('250 OK queued\r\n');
        got.done!();
      }
      for (let i = buf.indexOf('\r\n'); !inData && i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        got.commands.push(line);
        if (line.startsWith('EHLO')) sock.write('250-fake.test\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
        else if (line === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n');
        else if (got.commands.at(-2) === 'AUTH LOGIN') sock.write('334 UGFzc3dvcmQ6\r\n');
        else if (got.commands.at(-3) === 'AUTH LOGIN') sock.write(Buffer.from(line, 'base64').toString() === 'rahasia' ? '235 OK\r\n' : '535 no\r\n');
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) sock.write('250 OK\r\n');
        else if (line === 'DATA') {
          sock.write('354 go ahead\r\n');
          inData = true;
        } else if (line === 'QUIT') sock.end('221 bye\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const cfg = { host: '127.0.0.1', port: (srv.address() as AddressInfo).port, user: 'bantuan@synt.fun', pass: 'rahasia', from: 'Synteel <bantuan@synt.fun>', to: ['tim@synt.fun'] };
  return { got, delivered, cfg, close: () => srv.close() };
}

/** Headers and the decoded body of a message as the server received it. */
function parse(data: string) {
  const unstuffed = data.replace(/(^|\r\n)\.\./g, '$1.');
  const [head, body] = unstuffed.split('\r\n\r\n');
  const subject = head.match(/^Subject: ((?:.*)(?:\r\n .*)*)/m)![1];
  const decoded = subject.split('\r\n ').map((w) => {
    const m = w.match(/^=\?UTF-8\?B\?(.*)\?=$/);
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : w;
  });
  return { head, subject: decoded.join(''), body: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

test('mail goes out over plain SMTP with AUTH LOGIN, a UTF-8 subject and body', async () => {
  const smtp = await fakeSmtp();
  const mail: Mail = { subject: 'Tiket #0007: Catat dan suara — suhu 28,9 °C', text: 'Baris satu\n.titik di awal\nSuhu 29 °C' };
  await sendMail(smtp.cfg, mail);
  await smtp.delivered;
  smtp.close();
  assert.deepEqual(smtp.got.commands.slice(0, 2), ['EHLO synteel', 'AUTH LOGIN']);
  assert.ok(smtp.got.commands.includes('MAIL FROM:<bantuan@synt.fun>'));
  assert.ok(smtp.got.commands.includes('RCPT TO:<tim@synt.fun>'));
  const msg = parse(smtp.got.data);
  assert.equal(msg.subject, mail.subject);
  assert.equal(msg.body, 'Baris satu\r\n.titik di awal\r\nSuhu 29 °C');
  assert.match(msg.head, /^Content-Type: text\/plain; charset=UTF-8$/m);
});

test('mail helpers: dot-stuffing, encoded words under 76 characters, plain ASCII left alone', () => {
  assert.equal(dotStuff('.a\r\nb\r\n.\r\n..c'), '..a\r\nb\r\n..\r\n...c');
  assert.equal(encodeHeader('Tiket #0001'), 'Tiket #0001');
  const long = encodeHeader('é'.repeat(80));
  for (const line of long.split('\r\n')) assert.ok(line.length <= 76, line);
  const msg = buildMessage({ from: 'a@b.c', to: ['d@e.f'] }, { subject: 's', text: 'x'.repeat(200) });
  for (const line of msg.split('\r\n')) assert.ok(line.length <= 78);
});

test('a refused password, a closed port and a silent server all reject', async () => {
  const smtp = await fakeSmtp();
  await assert.rejects(sendMail({ ...smtp.cfg, pass: 'salah' }, { subject: 's', text: 't' }), /SMTP AUTH: 535/);
  smtp.close();
  const silent = await fakeSmtp({ greet: false });
  await assert.rejects(sendMail({ ...silent.cfg, timeoutMs: 200 }, { subject: 's', text: 't' }), /timeout/);
  silent.close();
  await assert.rejects(sendMail({ ...silent.cfg, port: 1 }, { subject: 's', text: 't' }));
  // Not configured: no mailer, tickets are only stored.
  assert.equal(mailer(null), null);
});

test('support works signed out; the ticket is stored and mailed after the answer', async () => {
  const smtp = await fakeSmtp();
  const { client, store } = server(undefined, { mail: mailer(smtp.cfg) });
  const call = client();
  const res = await call('POST', '/support', { topic: 'pin', message: 'Pemilik lupa PIN dan tidak bisa masuk', replyPhone: '0812 3456 7890', accountPhone: '0813-1111-2222' });
  assert.equal(res.status, 201);
  assert.equal(res.json.ticket, '0001');
  await smtp.delivered;
  smtp.close();
  const msg = parse(smtp.got.data);
  assert.equal(msg.subject, '[Synteel] Tiket #0001: Masuk dan PIN');
  assert.match(msg.body, /Pemilik lupa PIN/);
  assert.match(msg.body, /WhatsApp untuk balasan: \+6281234567890/);
  assert.match(msg.body, /Nomor HP akun: \+6281311112222/);
  assert.match(msg.body, /Pengguna: belum masuk/);
  assert.match(msg.body, /Perangkat: tidak disertakan/);
  // Stored without a person; marked as mailed once the server accepted it.
  for (let i = 0; i < 50 && !store.supportTicket(1)?.mailedAt; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.supportTicket(1)?.userId, null);
  assert.ok(store.supportTicket(1)?.mailedAt);
});

test('the website contact form asks for a reply by e-mail; a bad address is refused', async () => {
  const smtp = await fakeSmtp();
  const { client } = server(undefined, { mail: mailer(smtp.cfg) });
  const call = client();
  assert.equal((await call('POST', '/support', { topic: 'lain', message: 'Halo, saya punya 4 kolam elver', replyEmail: 'bukan-email' })).status, 400);
  const res = await call('POST', '/support', { topic: 'lain', message: 'Name: Sari\nPonds: 4\nHalo, saya punya 4 kolam elver', replyEmail: 'Sari@Example.com' });
  assert.equal(res.status, 201);
  await smtp.delivered;
  smtp.close();
  const msg = parse(smtp.got.data);
  assert.match(msg.body, /Email untuk balasan: sari@example\.com/);
  assert.doesNotMatch(msg.body, /WhatsApp untuk balasan/);
});

test('support signed in names the person and farm; validation and the hourly limit', async () => {
  const mails: Mail[] = [];
  const { worker, owner, client } = await farmWithWorker(undefined, {
    mail: async (m) => {
      mails.push(m);
    },
  });
  const res = await worker('POST', '/support', { topic: 'catat', message: 'Suara di Kolam B tidak terbaca', replyPhone: '082222222222', device: 'Android 13, Chrome 130, app 0.4' });
  assert.equal(res.status, 201);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(mails[0].text, /Pengguna: Pak Joko \(SE-000002\), pekerja/);
  assert.match(mails[0].text, /Tambak: Tambak Sidat Mitra/);
  assert.match(mails[0].text, /Perangkat: Android 13/);
  assert.match(mails[0].text, /Nomor HP akun: \+6282222222222/);

  assert.equal((await owner('POST', '/support', { message: 'abc', replyPhone: '081111111111' })).status, 400);
  assert.equal((await owner('POST', '/support', { message: 'x'.repeat(2001), replyPhone: '081111111111' })).status, 400);
  const badPhone = await owner('POST', '/support', { message: 'Halo tim', replyPhone: '12' });
  assert.equal(badPhone.status, 400);
  assert.match(badPhone.json.error, /Nomor WhatsApp/);
  assert.equal((await owner('POST', '/support', { topic: 'x', message: 'Halo tim', replyPhone: '081111111111' })).status, 400);

  // Five per hour from one address (the worker's ticket above was the first) …
  for (let i = 0; i < 4; i++) assert.equal((await owner('POST', '/support', { message: `Halo tim ${i}`, replyPhone: '081111111111' })).status, 201);
  const limited = await owner('POST', '/support', { message: 'Halo tim lagi', replyPhone: '081111111111' });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'locked');
  // … and five per reply number from anywhere.
  const elsewhere = client({ 'x-forwarded-for': '203.0.113.9' });
  assert.equal((await elsewhere('POST', '/support', { message: 'Halo tim', replyPhone: '081111111111' })).status, 201);
  assert.equal((await elsewhere('POST', '/support', { message: 'Halo tim', replyPhone: '081111111111' })).status, 429);
  assert.equal((await elsewhere('POST', '/support', { message: 'Halo tim', replyPhone: '085555555555' })).status, 201);
});

test('a failing mail server never fails the request', async () => {
  const { client } = server(undefined, { mail: async () => Promise.reject(new Error('SMTP down')) });
  const res = await client()('POST', '/support', { topic: 'lain', message: 'Halo tim Synteel', replyPhone: '0812 3456 7890' });
  assert.equal(res.status, 201);
  assert.equal(res.json.ticket, '0001');
  const plain = server();
  assert.equal((await plain.client()('POST', '/support', { message: 'Halo tim Synteel', replyPhone: '0812 3456 7890' })).status, 201);
});
