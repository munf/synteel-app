import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type QuotaState, type Role } from '../api.ts';
import type { Go } from '../app.tsx';
import { fmtClock } from '../labels.ts';
import { Icon, initialOf, roleLabel, Soon, Tick, type IconName } from '../ui.tsx';

const AMBER = { bg: 'var(--warn-bg)', fg: '#6b4100', track: '#f6ddb0' };

/** The remaining-reads bar; amber once the day's reads are used up. */
export function QuotaBar({ q }: { q: QuotaState }) {
  const pct = q.cap > 0 ? Math.round((q.left / q.cap) * 100) : 0;
  return (
    <span role="img" aria-label={`${q.left} dari ${q.cap} tersisa`} class="progress" style={{ display: 'block', background: q.left === 0 ? AMBER.track : 'var(--tint)' }}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

const USES: { label: string; icon: IconName }[] = [
  { label: 'Bicara', icon: 'mic' },
  { label: 'Foto alat ukur', icon: 'camera' },
  { label: 'Video harian', icon: 'video' },
];

// Prices are not decided yet: the packs are shown without them and cannot be bought.
const PACKS = [
  { name: '+50 bacaan', sub: 'Untuk hari sibuk' },
  { name: '+200 bacaan', sub: 'Paling sering dipilih' },
  { name: 'Langganan bulanan', sub: '150 bacaan per hari' },
];

function Hero({ q }: { q: QuotaState }) {
  if (q.unlimited) {
    return (
      <section class="card">
        <span class="label semi muted">Sisa hari ini</span>
        <h2>Tidak ada batas harian</h2>
        <span class="ink2">Saat ini tambak ini belum punya batas bacaan AI per hari. Dipakai hari ini: {q.used} bacaan.</span>
      </section>
    );
  }
  const out = q.left === 0;
  const reset = fmtClock(Date.parse(q.resetsAt));
  return (
    <section class="card" style={out ? { background: AMBER.bg, color: AMBER.fg } : undefined}>
      <span class="label semi" style={{ color: out ? AMBER.fg : 'var(--muted)' }}>
        Sisa hari ini
      </span>
      <span class="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <span class="big">{q.left}</span>
        <span class="h2" style={{ fontWeight: 400, color: out ? AMBER.fg : 'var(--muted)' }}>
          dari {q.cap} bacaan
        </span>
      </span>
      <QuotaBar q={q} />
      <span class="label" style={{ color: out ? AMBER.fg : 'var(--muted)' }}>
        {out
          ? `Habis. Terisi lagi besok jam ${reset}. Rekaman yang dibuat sekarang tetap disimpan dan dibaca setelah jatah ada.`
          : `Terisi penuh lagi tiap jam ${reset}.`}
      </span>
    </section>
  );
}

/** "✓ Foto" when done, "Foto belum" when not: a word, not colour alone. */
function Done({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <span class="word ok">
      <Tick /> {label}
    </span>
  ) : (
    <span class="word warn">{label} belum</span>
  );
}

function EarnRow({ title, children, bonus, earned, onClick }: { title: string; children: ComponentChildren; bonus: number; earned?: boolean; onClick: () => void }) {
  return (
    <button type="button" class="list-row" onClick={onClick} style={{ width: '100%', border: 0, background: 'none', padding: '16px 0', textAlign: 'left', color: 'inherit' }}>
      <span class="grow stack-xs">
        <span class="strong">{title}</span>
        {children}
      </span>
      <span class={`pill ${earned ? 'ok' : 'blue'}`} style={{ fontWeight: 800 }}>
        {earned && <Tick />}+{bonus}
      </span>
    </button>
  );
}

export function Quota({ role, go }: { role: Role | null; go: Go }) {
  const [q, setQ] = useState<QuotaState | null>(null);
  const [error, setError] = useState('');
  const owner = role === 'owner';

  const load = () => {
    setError('');
    api.quota().then(setQ, (e) => setError(e.message));
  };
  useEffect(load, []);

  const pv = q?.earn.photoVideo;
  const streak = q?.earn.streak;
  const ask = q && `Jatah baca AI di Synteel hari ini ${q.left === 0 ? 'habis' : `tinggal ${q.left}`}. Mohon ditambah di Synteel › Profil › Jatah baca AI.`;

  return (
    <div class="screen">
      <header class="row">
        <button class="icon-btn" aria-label="Kembali ke Profil" onClick={() => go({ name: 'profile' })}>
          <Icon name="back" />
        </button>
        <div class="stack-xs">
          <h1 style={{ lineHeight: 1.1 }}>Jatah baca AI</h1>
          <span class="meta">Satu jatah untuk semua anggota tambak</span>
        </div>
      </header>

      {!q && !error && <p class="muted">Memuat…</p>}
      {error && (
        <div class="stack-sm">
          <p class="error">Jatah belum bisa dimuat: {error}</p>
          <button class="btn secondary" onClick={load}>
            Coba lagi
          </button>
        </div>
      )}

      {q && pv && streak && (
        <>
          <Hero q={q} />

          <section class="stack">
            <h2>Satu rekaman = 1 bacaan</h2>
            <div class="grid3">
              {USES.map((u) => (
                <div key={u.label} class="card" style={{ padding: '16px 4px', gap: 4, alignItems: 'center', textAlign: 'center' }}>
                  <span style={{ color: 'var(--accent)' }}>
                    <Icon name={u.icon} />
                  </span>
                  <span class="label semi">{u.label}</span>
                </div>
              ))}
            </div>
            <div class="note ok" style={{ fontSize: '1rem' }}>
              <Icon name="check" />
              <span>
                <b>Tidak memakai jatah:</b> laporan darurat dan hitung sidat mati, ketik sendiri, briefing sore dan Waspada.
              </span>
            </div>
          </section>

          <section class="stack">
            <h2>Tambah gratis</h2>
            <div class="card list">
              <EarnRow title="1 foto + 1 video kolam hari ini" bonus={pv.bonus} earned={pv.earned} onClick={() => go({ name: 'record' })}>
                <span class="row" style={{ gap: 16 }}>
                  <Done on={pv.photo} label="Foto" />
                  <Done on={pv.video} label="Video" />
                </span>
              </EarnRow>
              <EarnRow title="Mencatat 7 hari beruntun" bonus={streak.bonus} onClick={() => go({ name: 'rewards' })}>
                <span class="meta">
                  Sekarang {streak.days} hari
                  <br />
                  Hadiah berikutnya di hari ke-{streak.nextAt}
                </span>
              </EarnRow>
            </div>
          </section>

          {owner && (
            <section class="stack">
              <div class="row between">
                <h2>Beli jatah tambahan</h2>
                <Soon />
              </div>
              <div class="stack-sm" aria-disabled="true">
                {PACKS.map((p) => (
                  <div key={p.name} class="stack-xs" style={{ background: '#fff', border: '2px solid var(--line-2)', borderRadius: 16, padding: '12px 16px', minHeight: 64, justifyContent: 'center' }}>
                    <span class="strong">{p.name}</span>
                    <span class="meta">{p.sub}</span>
                  </div>
                ))}
              </div>
              <button type="button" class="btn primary" disabled>
                Bayar dengan QRIS
              </button>
              <span class="meta">Jatah tambahan dipakai setelah jatah harian habis dan berlaku 30 hari.</span>
            </section>
          )}

          {owner && q.members.length > 0 && (
            <section class="stack">
              <h2>Dipakai hari ini</h2>
              <div class="card list">
                {q.members.map((m) => (
                  <div key={m.userId} class="list-row" style={{ minHeight: 72 }}>
                    <span class="avatar" aria-hidden="true">
                      {initialOf(m.name)}
                    </span>
                    <span class="grow stack-xs" style={{ gap: 0 }}>
                      <span class="semi">{m.name}</span>
                      <span class="meta">{roleLabel[m.role]}</span>
                    </span>
                    <span class="strong num">{m.used} bacaan</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!owner && (
            <section class="card">
              <h2>Butuh jatah lebih?</h2>
              <p class="ink2">Hanya pemilik tambak yang bisa membeli jatah tambahan.</p>
              <a class="btn primary" href={`https://wa.me/?text=${encodeURIComponent(ask ?? '')}`} target="_blank" rel="noopener">
                <Icon name="chat" size={20} /> Minta pemilik lewat WhatsApp
              </a>
            </section>
          )}
        </>
      )}
    </div>
  );
}
