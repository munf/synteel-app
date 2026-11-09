// Public, read-only replay of recorded AI runs (no sign-in, no API calls): what went in, which model
// calls were made, the app's code checks with a tick or a cross, and what the farmer was shown.
// The runs come from runs.json, written by scripts/replay-export.ts (server/src/replay.ts) and already
// anonymised. Each run says whether a real model API answered or it is a demo with sample answers.
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { modelName, STEP } from '../aihow.tsx';
import { isEn, lang, LOCALE, setLang, t } from '../i18n.ts';
import { colorLabel, fmtNum, leftoverLabel, smellLabel, aerationCheckLabel } from '../labels.ts';
import { applyTextSize } from '../prefs.ts';
import { Icon } from '../ui.tsx';
import type { ReplayCall, ReplayCheck, ReplayResult, ReplayRun, RunBundle, Words } from '../../../server/src/replay.ts';
import bundle from './runs.json';
import '../style.css';
import './replay.css';

const runs = (bundle as RunBundle).runs;

const KIND: Record<string, () => string> = {
  round: () => t('Keliling kolam dengan suara', 'Voice round of the ponds'),
  count: () => t('Hitung sidat mati dari foto', 'Dead eels counted from a photo'),
  case: () => t('Kasus sidat mati: ringkasan', 'Dead-eel case: update'),
  briefing: () => t('Ringkasan malam', 'Evening briefing'),
  photo: () => t('Foto alat ukur', 'Meter photo'),
  voice: () => t('Catatan suara', 'Voice note'),
};

const FIELD: Record<string, (v: number | string) => string> = {
  temperature: (v) => t(`suhu ${fmtNum(Number(v))} °C`, `temperature ${fmtNum(Number(v))} °C`),
  ph: (v) => `pH ${fmtNum(Number(v))}`,
  tds: (v) => `TDS ${fmtNum(Number(v))} ppm`,
  do: (v) => t(`oksigen ${fmtNum(Number(v))} mg/L`, `oxygen ${fmtNum(Number(v))} mg/L`),
  mortality: (v) => t(`${v} ekor mati`, `${v} dead`),
  color: (v) => t(`air ${colorLabel[v as keyof typeof colorLabel]?.toLowerCase() ?? v}`, `water ${colorLabel[v as keyof typeof colorLabel]?.toLowerCase() ?? v}`),
  smell: (v) => t(`bau ${smellLabel[v as keyof typeof smellLabel]?.toLowerCase() ?? v}`, `smell ${smellLabel[v as keyof typeof smellLabel]?.toLowerCase() ?? v}`),
  leftover: (v) => leftoverLabel[v as keyof typeof leftoverLabel]?.toLowerCase() ?? String(v),
  aeration: (v) => t(`aerator ${aerationCheckLabel[v as keyof typeof aerationCheckLabel]?.toLowerCase() ?? v}`, `aerator ${aerationCheckLabel[v as keyof typeof aerationCheckLabel]?.toLowerCase() ?? v}`),
};
const HELD: Record<string, () => string> = { temperature: () => t('suhu', 'temperature'), ph: () => 'pH', tds: () => 'TDS', do: () => t('oksigen', 'oxygen'), mortality: () => t('jumlah mati', 'number dead') };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB' : null;
const clock = (iso: string) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' });
const secs = (ms: number) => (ms < 1000 ? t(`${ms} milidetik`, `${ms} ms`) : t(`${fmtNum(Math.round(ms / 100) / 10)} detik`, `${fmtNum(Math.round(ms / 100) / 10)} s`));

/** Words in the page's language, or the other one when only that exists. */
const w = (x: Words | undefined) => (x ? (x[lang] ?? x.id ?? x.en ?? '') : '');

/** Calls of the same step and model started in the same second (SAM's prompts go out together) as one line. */
function grouped(calls: ReplayCall[]) {
  const out: (ReplayCall & { slowest: number | null })[] = [];
  for (const c of calls) {
    const last = out.at(-1);
    if (last && last.step === c.step && last.model === c.model && last.provider === c.provider && last.at && c.at && last.at.slice(0, 19) === c.at.slice(0, 19)) {
      last.calls += c.calls;
      last.slowest = Math.max(last.slowest ?? 0, c.ms ?? 0);
    } else out.push({ ...c, slowest: c.ms });
  }
  return out;
}

/** The checks in the page's language; a run kept in one language only shows that one. */
const checksIn = (items: ReplayCheck[]) => {
  const mine = items.filter((c) => c.lang === lang);
  return mine.length ? mine : items;
};

function Origin({ run }: { run: ReplayRun }) {
  return run.origin === 'real' ? (
    <span class="pill blue">
      <Icon name="sparkle" size={16} /> {t('API model nyata', 'Real model API')}
    </span>
  ) : (
    <span class="pill grey">{t('Demo, tanpa model', 'Demo, no model')}</span>
  );
}

function Result({ r }: { r: ReplayResult }) {
  if (r.type === 'round')
    return (
      <ul class="replay-list">
        {r.ponds.map((p) => {
          const shown = Object.entries(p.values).filter(([k]) => !p.held.includes(k) && FIELD[k]);
          return (
            <li key={p.pond}>
              <span class="strong">{p.pond}</span>
              <span>{shown.map(([k, v]) => FIELD[k](v)).join(' · ') || t('tidak ada angka diisi', 'nothing filled in')}</span>
              {p.held.map((h) => (
                <span key={h} class="replay-held">
                  <Icon name="alert" size={16} stroke={2.4} />
                  {t(`Cek manual: ${HELD[h]?.() ?? h} tidak diisi otomatis`, `Check by hand: ${HELD[h]?.() ?? h} not filled in`)}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    );
  if (r.type === 'count') {
    const seen = r.atLeast ? t(`sedikitnya ${r.low}`, `at least ${r.low}`) : r.low === r.high ? String(r.count) : `${r.low}–${r.high}`;
    return (
      <div class="stack-xs">
        {r.filled ? (
          <span class="strong">{t(`${r.count} ekor diisi di kolom jumlah mati`, `${r.count} filled in as the number dead`)}</span>
        ) : (
          <span class="replay-held strong">
            <Icon name="alert" size={16} stroke={2.4} />
            {t('Cek manual: jumlah tidak diisi, petani menghitung dari foto', 'Check by hand: no number filled in, the farmer counts from the photo')}
          </span>
        )}
        <span class="label ink2">
          {t(`Model melihat ${seen} ekor`, `The model saw ${seen}`)}
          {r.truth !== undefined && t(`; hitungan benar ${r.truth}`, `; true count ${r.truth}`)}
        </span>
      </div>
    );
  }
  if (r.type === 'text') {
    const text = r.text[lang] ?? r.text.id ?? r.text.en ?? '';
    return (
      <div class="stack-xs">
        <p>{text}</p>
        {!r.text[lang] && <span class="label ink2">{t('Hanya tersimpan dalam bahasa Inggris.', 'Kept in Indonesian only.')}</span>}
        {r.extra && r.extra.length > 0 && (
          <ul class="replay-bullets">
            {r.extra.slice(0, 5).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return <p class="ink2">{r.why[lang] ?? r.why.id ?? r.why.en}</p>;
}

const STAGES = () => [t('Masukan', 'Input'), t('Panggilan model', 'Model calls'), t('Dicek kode aplikasi', 'Checked by the app’s code'), t('Yang dilihat petani', 'What the farmer saw')];

function RunCard({ run }: { run: ReplayRun }) {
  // Step by step: one stage at a time, or all at once.
  const [shown, setShown] = useState(1);
  const stages = STAGES();
  const checks = run.checks ? checksIn(run.checks.items) : [];
  const total = run.calls.reduce((a, c) => a + c.calls, 0);
  const body = [
    <div key="in" class="stack-xs">
      {run.input.type === 'transcript' && <blockquote class="replay-quote">“{run.input.text}”</blockquote>}
      {run.input.type === 'photo' && (
        <span class="row" style={{ gap: 8 }}>
          <Icon name="camera" size={18} /> <span class="semi">{t('Foto', 'Photo')}</span>
        </span>
      )}
      {run.input.note && <span class="label ink2">{w(run.input.note)}</span>}
    </div>,
    <ol key="calls" class="ai-steps">
      {grouped(run.calls).map((c, i) => (
        <li key={i}>
          <span class="semi">{STEP[c.step]?.() ?? c.step}</span>
          <span class="label ink2">
            {[
              modelName(c.provider, c.model),
              c.calls > 1 ? t(`${c.calls} panggilan bersamaan`, `${c.calls} calls at once`) : '',
              c.at ? clock(c.at) : '',
              c.slowest !== null ? (c.calls > 1 && c.at ? t(`selesai dalam ${secs(c.slowest)}`, `done in ${secs(c.slowest)}`) : secs(c.slowest)) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </li>
      ))}
      {!run.calls[0]?.at && total > 1 && <li class="label ink2">{t(`${total} panggilan model, waktu per panggilan tidak disimpan`, `${total} model calls, time per call not kept`)}</li>}
    </ol>,
    <div key="checks" class="stack-xs">
      {!run.checks || checks.length === 0 ? (
        <span class="ink2">{t('Tidak ada cek kode untuk hasil ini.', 'No code checks for this result.')}</span>
      ) : (
        <ul class="ai-checks">
          {checks.map((c, i) => (
            <li key={i} class={c.ok ? 'ok' : 'bad'}>
              <span class="ai-mark" aria-hidden="true">
                {c.ok ? (
                  <Icon name="check" size={16} stroke={2.6} />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                )}
              </span>
              <span class="stack-xs" style={{ gap: 0 }}>
                <span class="sr-only">{c.ok ? t('Lolos:', 'Passed:') : t('Tidak lolos:', 'Failed:')}</span>
                <span>{c.label}</span>
                {!c.ok && c.reason && <span class="label">{c.reason}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {run.checks?.partial && (
        <span class="label ink2">{t('Run ini hanya menyimpan hasil cek dan angka yang ditahan, tidak setiap cek.', 'This run kept the outcome and the held values only, not every check.')}</span>
      )}
    </div>,
    <Result key="result" r={run.result} />,
  ];
  return (
    <article class="card replay-run" aria-label={KIND[run.kind]?.() ?? run.kind}>
      <div class="stack-sm">
        <div class="row between top">
          <h2>{KIND[run.kind]?.() ?? run.kind}</h2>
          <Origin run={run} />
        </div>
        <span class="label ink2">{[when(run.at), w(run.source)].filter(Boolean).join(' · ')}</span>
      </div>
      <ol class="replay-stages">
        {body.slice(0, shown).map((b, i) => (
          <li key={i} class="replay-stage">
            <span class="replay-num" aria-hidden="true">
              {i + 1}
            </span>
            <div class="stack-sm grow">
              <h3>{stages[i]}</h3>
              {b}
            </div>
          </li>
        ))}
      </ol>
      {shown < 4 ? (
        <div class="row" style={{ gap: 8 }}>
          <button type="button" class="btn primary" onClick={() => setShown(shown + 1)}>
            {t('Lanjut', 'Next')} <Icon name="next" size={18} />
          </button>
          <button type="button" class="btn secondary grow" onClick={() => setShown(4)}>
            {t('Semua langkah', 'All steps')}
          </button>
        </div>
      ) : (
        <button type="button" class="link-btn row" style={{ gap: 6, alignSelf: 'flex-start' }} onClick={() => setShown(1)}>
          <Icon name="refresh" size={18} /> {t('Putar dari awal', 'Play from the start')}
        </button>
      )}
    </article>
  );
}

type Filter = 'all' | 'real' | 'demo';

function Replay() {
  const [filter, setFilter] = useState<Filter>('all');
  const list = runs.filter((r) => filter === 'all' || r.origin === filter);
  const real = runs.filter((r) => r.origin === 'real').length;
  const options: [Filter, string][] = [
    ['all', t(`Semua (${runs.length})`, `All (${runs.length})`)],
    ['real', t(`API nyata (${real})`, `Real API (${real})`)],
    ['demo', t(`Demo (${runs.length - real})`, `Demo (${runs.length - real})`)],
  ];
  return (
    <main class="screen replay">
      <header class="stack-sm">
        <div class="row between">
          <span class="row" style={{ gap: 8 }}>
            <img src="../favicon.svg" width="28" height="28" alt="" />
            <span class="strong">Synteel</span>
          </span>
          <span class="row" style={{ gap: 4 }} role="group" aria-label={t('Bahasa', 'Language')}>
            {(['id', 'en'] as const).map((l) => (
              <button key={l} type="button" class={`chip${lang === l ? ' on' : ''}`} aria-pressed={lang === l} onClick={() => setLang(l)}>
                {l === 'id' ? 'Indonesia' : 'English'}
              </button>
            ))}
          </span>
        </div>
        <h1>{t('Proses AI yang terekam, diputar ulang', 'Recorded AI runs, replayed')}</h1>
        <p class="ink2">
          {t(
            'Setiap hasil AI di aplikasi dicek kode dulu sebelum petani melihatnya. Di sini proses itu bisa diikuti langkah demi langkah: masukan, panggilan model dengan waktunya, cek dengan tanda ✓ atau ✗, lalu hasil yang dilihat petani.',
            'Every AI result in the app is checked by code before the farmer sees it. Here each run can be followed step by step: the input, the model calls with their times, the checks with ✓ or ✗, and what the farmer saw.',
          )}
        </p>
        <p class="note info">
          <Icon name="info" />
          <span>
            {t(
              'API nyata: model Meta benar-benar menjawab (uji 10 November 2026). Demo: tambak contoh dengan jawaban contoh, tanpa model. Tanpa nama petani, nomor, wajah, atau lokasi yang lebih rinci dari desa.',
              'Real API: a Meta model actually answered (test runs of 10 November 2026). Demo: the sample farm with sample answers, no model. No farmer names, numbers, faces, or places finer than the village.',
            )}
          </span>
        </p>
      </header>
      <div class="chips" role="group" aria-label={t('Saring', 'Filter')}>
        {options.map(([k, label]) => (
          <button key={k} type="button" class={`chip${filter === k ? ' on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {filter === k && <Icon name="check" size={16} stroke={3} />}
            {label}
          </button>
        ))}
      </div>
      {list.map((r) => (
        <RunCard key={r.id} run={r} />
      ))}
      <p class="label ink2">
        {t('Data: ', 'Data: ')}
        <a href="https://github.com/munf/synteel-app/blob/main/docs/evaluation.md">docs/evaluation.md</a>
        {t(', dibuat dengan ', ', made with ')}
        <code>scripts/replay-export.ts</code>.
      </p>
    </main>
  );
}

applyTextSize();
if (isEn) document.title = 'Synteel · Replay';
render(<Replay />, document.getElementById('app')!);
