// "Punya kode undangan": a signed-in account (new, still on "Siapkan tambak", or already in a farm) joins the farm
// of an owner's invite code. The farm name and role show first; nothing happens until "Gabung" is tapped.
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type Me, type Role } from './api.ts';
import { Field, Icon, Notice, roleLabel } from './ui.tsx';
import { t } from './i18n.ts';

export function JoinByCode({ onJoined, open: startOpen = false }: { onJoined: (m: Me) => void; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [code, setCode] = useState('');
  const [farm, setFarm] = useState<{ farmName: string; role: Role } | null>(null);
  const [bad, setBad] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setFarm(null);
    setBad(false);
    setError('');
    if (code.length !== 6) return;
    let live = true;
    setChecking(true);
    api.invite(code).then(
      (f) => live && setFarm(f),
      (e) => {
        if (!live) return;
        if (e instanceof ApiError && (e.code === 'invite_invalid' || [404, 410].includes(e.status))) setBad(true);
        else setError((e as Error).message);
      },
    ).finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [code]);

  if (!open)
    return (
      <button type="button" class="btn secondary block" onClick={() => setOpen(true)}>
        <Icon name="users" size={20} /> {t('Punya kode undangan', 'Have an invite code')}
      </button>
    );

  const join = async () => {
    setBusy(true);
    setError('');
    try {
      onJoined(await api.joinFarm(code));
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'invite_invalid' || [404, 410].includes(e.status))) setBad(true);
      else setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="stack">
      <Field label={t('Kode undangan', 'Invite code')} hint={t('6 huruf dan angka, dari pesan pemilik tambak', "6 letters and numbers, from the farm owner's message")}>
        <input
          class="code-input"
          value={code}
          maxLength={6}
          autoCapitalize="characters"
          autoComplete="off"
          spellcheck={false}
          placeholder={t('contoh: K7QM2P', 'example: K7QM2P')}
          onInput={(e) => {
            const v = e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            e.currentTarget.value = v;
            setCode(v);
          }}
        />
      </Field>
      {checking && <p class="working">{t('Memeriksa kode…', 'Checking the code…')}</p>}
      {bad && (
        <Notice tone="info" icon="info" title={t('Kode ini sudah tidak berlaku', 'This code no longer works')} role="alert">
          {t('Kode undangan berlaku 7 hari dan hanya bisa dipakai sekali. Minta kode baru ke pemilik tambak.', 'An invite code works for 7 days and only once. Ask the farm owner for a new code.')}
        </Notice>
      )}
      {farm && (
        <div class="note ok" style={{ fontSize: '1rem' }}>
          <Icon name="check" stroke={3} />
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <b>{farm.farmName}</b>
            <span>{t('Bergabung sebagai', 'Joining as a')} {roleLabel[farm.role].toLowerCase()}</span>
          </span>
        </div>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {farm && (
        <button type="button" class="btn primary block" disabled={busy} onClick={join}>
          {busy ? t('Tunggu…', 'Wait…') : t(`Gabung ke ${farm.farmName}`, `Join ${farm.farmName}`)}
        </button>
      )}
    </div>
  );
}
