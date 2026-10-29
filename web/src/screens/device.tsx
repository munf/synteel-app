// "Hubungkan alat": the farmer types or scans the code on a Synteel device (today: a simulated Synteel Nursery
// Gen0 from eel.synt.fun/sim). The device shows first, with what it measures and what linking will do; nothing
// changes until the owner taps "Hubungkan". A simulated device gets new ponds of its own, marked "Simulasi",
// so its numbers never mix with real ponds.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type DeviceInfo, type Role } from '../api.ts';
import type { Go } from '../app.tsx';
import { Field, Icon, Notice } from '../ui.tsx';
import { siteInAppLanguage, t } from '../i18n.ts';
import './device.css';

/** Letters and digits only, upper case: "g5 7kq2-m4" → "N07KQ2M4". */
const bare = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "N07KQ2M4" → "N0-7KQ2-M4", dashes added as the code is typed. */

export function formatCode(raw: string): string {
  const s = bare(raw).slice(0, 8);
  return [s.slice(0, 2), s.slice(2, 6), s.slice(6, 8)].filter(Boolean).join('-');
}

/** A scanned QR: the bare code, or the app link the simulator encodes (…/app/?device=CODE). */
export function codeFromScan(text: string): string | null {
  const v = text.trim();
  try {
    const u = new URL(v);
    const c = u.searchParams.get('device');
    if (c) return formatCode(c);
  } catch {
    // not a link: maybe the code itself
  }
  const s = bare(v);
  return s.length === 8 ? formatCode(s) : null;
}

const complete = (code: string) => bare(code).length === 8;

interface Detector {
  detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;
const Barcode = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
const canScan = () => Boolean(Barcode && navigator.mediaDevices?.getUserMedia);

/** The camera with a QR reader; calls back once with the first code it understands. */
function Scanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [odd, setOdd] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;
    const detector = new Barcode!({ formats: ['qr_code'] });
    const look = async () => {
      if (!live) return;
      const v = video.current;
      if (v && v.readyState >= 2) {
        try {
          const found = await detector.detect(v);
          for (const f of found) {
            const code = codeFromScan(f.rawValue);
            if (code) {
              live = false;
              onCode(code);
              return;
            }
            setOdd(true);
          }
        } catch {
          // a frame the reader could not use: try the next one
        }
      }
      timer = setTimeout(look, 300);
    };
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(
      (s) => {
        if (!live) return s.getTracks().forEach((tr) => tr.stop());
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          video.current.play().catch(() => {});
        }
        look();
      },
      (e: Error) =>
        setError(
          e.name === 'NotAllowedError'
            ? t('Izin kamera ditolak. Ketik kodenya saja, atau izinkan kamera di pengaturan browser.', 'Camera permission was denied. Type the code instead, or allow the camera in the browser settings.')
            : t('Kamera tidak bisa dibuka. Ketik kodenya saja.', 'The camera could not be opened. Type the code instead.'),
        ),
    );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  return (
    <section class="card">
      <div class="row between">
        <h2>{t('Arahkan kamera ke kode QR', 'Point the camera at the QR code')}</h2>
      </div>
      {error ? (
        <Notice tone="warn" icon="camera" title={t('Kamera tidak terbuka', 'Camera not open')}>
          {error}
        </Notice>
      ) : (
        <div class="scan-box">
          <video ref={video} muted playsInline autoPlay aria-label={t('Gambar kamera', 'Camera view')} />
          <span class="scan-frame" aria-hidden="true" />
        </div>
      )}
      {odd && !error && <p class="label ink2">{t('Kode QR ini bukan kode alat Synteel.', 'This QR code is not a Synteel device code.')}</p>}
      <button type="button" class="btn secondary" onClick={onClose}>
        {t('Ketik kode saja', 'Type the code instead')}
      </button>
    </section>
  );
}

export function ConnectDevice({ initialCode, role, onLinked, go }: { initialCode?: string; role: Role | null; onLinked: () => Promise<unknown> | void; go: Go }) {
  const [code, setCode] = useState(initialCode ? formatCode(initialCode) : '');
  const [scanning, setScanning] = useState(false);
  const [noScan, setNoScan] = useState(false);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState('');
  const owner = role === 'owner';

  const look = async (c = code) => {
    if (!complete(c)) {
      setError(t('Kode alat terdiri dari 8 huruf dan angka, contoh: N0-7KQ2-M4.', 'A device code has 8 letters and numbers, for example: N0-7KQ2-M4.'));
      return;
    }
    setChecking(true);
    setError('');
    try {
      setDevice((await api.device(c)).device);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  // Opened from the simulator's QR link: the code is already filled in, so look it up at once.
  useEffect(() => {
    if (initialCode && complete(initialCode)) look(formatCode(initialCode));
  }, []);

  const link = async () => {
    if (!device) return;
    setLinking(true);
    setError('');
    try {
      await api.linkDevice(device.code);
      await onLinked();
      go({ name: 'record' });
    } catch (e) {
      setError((e as Error).message);
      setLinking(false);
    }
  };

  const restart = () => {
    setDevice(null);
    setError('');
  };

  const sim = t('Simulasi', 'Simulation');
  const newNames = device ? device.units.map((u) => `${device.short} ${u.name}`) : [];
  const joinNames = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} ${t('dan', 'and')} ${names.at(-1)}` : (names[0] ?? ''));

  return (
    <div class="screen">
      <header class="row">
        <button class="icon-btn" aria-label={t('Kembali', 'Back')} onClick={() => go({ name: 'record' })}>
          <Icon name="back" />
        </button>
        <h1 class="grow">{t('Hubungkan alat Synteel', 'Connect a Synteel device')}</h1>
      </header>

      {!device && (
        <>
          <p class="ink2">
            {t(
              'Ketik kode yang tertulis di alat, atau scan kode QR-nya. Angka dari alat lalu masuk sendiri dan ikut dicek seperti catatan lain.',
              'Type the code written on the device, or scan its QR code. Its readings then come in by themselves and are checked like any other record.',
            )}
          </p>

          {scanning ? (
            <Scanner
              onCode={(c) => {
                setScanning(false);
                setCode(c);
                look(c);
              }}
              onClose={() => setScanning(false)}
            />
          ) : (
            <section class="card">
              <form
                class="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  look();
                }}
              >
                <Field label={t('Kode alat', 'Device code')} hint={t('contoh: N0-7KQ2-M4', 'example: N0-7KQ2-M4')}>
                  <input
                    class="code-input"
                    value={code}
                    autoCapitalize="characters"
                    autoComplete="off"
                    autoCorrect="off"
                    spellcheck={false}
                    inputMode="text"
                    maxLength={10}
                    aria-invalid={error ? true : undefined}
                    placeholder="N0-XXXX-XX"
                    onInput={(e) => {
                      const v = formatCode(e.currentTarget.value);
                      e.currentTarget.value = v;
                      setCode(v);
                      setError('');
                    }}
                  />
                </Field>
                {error && (
                  <p class="error" role="alert">
                    {error}
                  </p>
                )}
                <button type="submit" class="btn primary" disabled={checking || !code}>
                  {checking ? t('Mencari alat…', 'Looking up the device…') : t('Lanjut', 'Continue')}
                </button>
              </form>
              <button
                type="button"
                class="btn secondary"
                onClick={() => {
                  if (canScan()) {
                    setNoScan(false);
                    setScanning(true);
                  } else setNoScan(true);
                }}
              >
                <Icon name="camera" /> {t('Scan kode QR', 'Scan QR code')}
              </button>
              {noScan && (
                <Notice tone="info" icon="info" title={t('Browser ini belum bisa membaca kode QR', 'This browser cannot read QR codes yet')}>
                  {t(
                    'Ketik kode yang tertulis di bawah kode QR, atau arahkan aplikasi kamera ke kode QR: tautannya membuka Synteel dengan kode terisi.',
                    'Type the code written under the QR code, or point the phone camera app at the QR code: its link opens Synteel with the code filled in.',
                  )}
                </Notice>
              )}
            </section>
          )}

          <section class="card" style={{ gap: 0 }}>
            <h2 class="label ink2" style={{ margin: 0, fontWeight: 600 }}>
              {t('Belum punya alat Synteel?', 'No Synteel device yet?')}
            </h2>
            <a class="link-row" href="https://eel.synt.fun/#hardware" target="_blank" rel="noopener" onClick={siteInAppLanguage}>
              <span>{t('Lihat alat Synteel', 'See Synteel devices')}</span>
              <Icon name="next" size={20} />
            </a>
            <a class="link-row" href="https://eel.synt.fun/sim/" target="_blank" rel="noopener" onClick={siteInAppLanguage}>
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span>{t('Coba alat simulasi', 'Try a simulated device')}</span>
                <span class="label ink2" style={{ fontWeight: 400 }}>
                  {t('Kodenya bisa langsung dihubungkan di sini', 'Its code can be connected right here')}
                </span>
              </span>
              <Icon name="next" size={20} />
            </a>
          </section>
        </>
      )}

      {device && (
        <>
          <section class="card">
            <div class="row top">
              <span class="icon-box">
                <Icon name="wifi" />
              </span>
              <div class="stack-xs grow">
                <h2>
                  {device.name}
                  {device.simulated && <span class="soon sim">{sim}</span>}
                </h2>
                <span class="label ink2 num">
                  {t('Kode', 'Code')} {device.code}
                </span>
              </div>
            </div>

            <div class="stack-sm">
              <span class="strong">{t('Yang diukur', 'What it measures')}</span>
              <ul class="device-sensors">
                {device.sensors.map((s) => (
                  <li key={s}>
                    <Icon name="check" size={16} stroke={2.5} />
                    {s}
                  </li>
                ))}
              </ul>
            </div>

            <div class="stack-sm">
              <span class="strong">{t('Yang terjadi', 'What will happen')}</span>
              {device.linkedHere ? (
                <p>
                  {t(
                    `Alat ini sudah terhubung ke tambak ini: ${joinNames(device.ponds.map((p) => p.name))}.`,
                    `This device is already connected to this farm: ${joinNames(device.ponds.map((p) => p.name))}.`,
                  )}
                </p>
              ) : device.simulated ? (
                <p>
                  {t(
                    `Membuat ${newNames.length} kolam simulasi baru: ${joinNames(newNames)}. Kolam yang ada tidak berubah. Angka simulasi datang sendiri dan ikut dicek aturan, perkiraan dan alarm.`,
                    `Makes ${newNames.length} new simulation ponds: ${joinNames(newNames)}. Existing ponds do not change. Simulated readings come in by themselves and go through the rules, forecast and alarms.`,
                  )}
                </p>
              ) : (
                <p>{t('Angka dari alat masuk ke kolam tambak ini.', "The device's readings go to this farm's ponds.")}</p>
              )}
            </div>

            {device.linkedElsewhere && !device.linkedHere && (
              <Notice tone="bad" icon="alert" title={t('Sudah terhubung ke tambak lain', 'Already connected to another farm')} role="alert">
                {t('Alat ini dipakai tambak lain. Periksa kodenya, atau minta tambak itu memutus alat dulu.', 'Another farm uses this device. Check the code, or ask that farm to disconnect it first.')}
              </Notice>
            )}
            {!owner && !device.linkedHere && !device.linkedElsewhere && (
              <Notice tone="info" icon="users" title={t('Hanya pemilik tambak yang bisa menghubungkan alat', 'Only the farm owner can connect a device')}>
                {t('Minta pemilik tambak membuka Synteel dan mengetik kode', 'Ask the farm owner to open Synteel and type the code')}{' '}
                <span style={{ whiteSpace: 'nowrap' }}>{device.code}</span>.
              </Notice>
            )}
            {error && (
              <p class="error" role="alert">
                {error}
              </p>
            )}
          </section>

          <div class="stack-sm" style={{ gap: 12 }}>
            {device.linkedHere ? (
              <button type="button" class="btn primary" onClick={() => go({ name: 'record' })}>
                {t('Lihat kolam', 'View ponds')} <Icon name="arrow" />
              </button>
            ) : (
              owner &&
              !device.linkedElsewhere && (
                <button type="button" class="btn primary" disabled={linking} onClick={link}>
                  <Icon name="wifi" /> {linking ? t('Menghubungkan…', 'Connecting…') : t('Hubungkan', 'Connect')}
                </button>
              )
            )}
            <button type="button" class="btn secondary" disabled={linking} onClick={restart}>
              {t('Ganti kode', 'Change the code')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
