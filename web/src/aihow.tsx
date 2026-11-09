// Verify before show, as the farmer sees it: "Cek manual" where a code check failed, and
// "Cara AI memproses ini" under each AI result: the steps, the models, the time taken and the
// checks with a tick or a cross. Costs stay on the team dashboard.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type AiStep, type Outcome, type Trace, type Verification } from './api.ts';
import { t } from './i18n.ts';
import { fmtNum } from './labels.ts';
import { Icon } from './ui.tsx';

export const STEP: Record<AiStep, () => string> = {
  speech: () => t('Suara diubah jadi teks', 'Speech turned into text'),
  read: () => t('Isi dibaca dan disusun', 'Content read and sorted'),
  segment: () => t('Sidat dicari di foto', 'Eels looked for in the photo'),
  agent: () => t('Agen melihat data tambak', 'The agent looked at the farm data'),
  rewrite: () => t('Teks diubah jadi ucapan', 'Text turned into speech'),
  rules: () => t('Ditulis dari aturan aplikasi', 'Written from the app rules'),
  mock: () => t('Mode contoh, tanpa AI', 'Sample mode, no AI'),
};

const PROVIDER: Record<string, string> = { meta: 'Meta', fireworks: 'Fireworks', baseten: 'Baseten' };

/** "meta" + "muse-spark-1.3" → "Muse Spark 1.3 · Meta". */
export function modelName(provider: string, model: string): string {
  if (provider === 'rules' || provider === 'mock') return '';
  const base = model.split('/').at(-1)!.replace(/-\d{4}$/, '');
  const name = base
    .split('-')
    .map((w) => (w === 'sam' ? 'SAM' : /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
  return `${name} · ${PROVIDER[provider] ?? provider}`;
}

const secs = (ms: number) => (ms < 1000 ? t('kurang dari 1 detik', 'under 1 second') : t(`${fmtNum(Math.round(ms / 100) / 10)} detik`, `${fmtNum(Math.round(ms / 100) / 10)} seconds`));

const OUTCOME: Partial<Record<Outcome, () => string>> = {
  error: () => t('Gagal, dicoba penyedia lain', 'Failed, another provider tried'),
  fallback: () => t('Dijawab penyedia cadangan', 'Answered by the backup provider'),
};

/** A held-back value: the reasons in plain words, never the unverified number as if it were read. */
export function CheckByHand({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <p class="note warn" role="status">
      <Icon name="alert" />
      <span class="stack-xs" style={{ gap: 2 }}>
        <span class="strong">{t('Cek manual', 'Check by hand')}</span>
        {reasons.slice(0, 3).map((r) => (
          <span key={r}>{r}</span>
        ))}
      </span>
    </p>
  );
}

/** The checks with a tick or a cross; status is shape and word, never colour alone. */
function Checks({ verify }: { verify: Verification }) {
  return (
    <ul class="ai-checks">
      {verify.checks.map((c, i) => (
        <li key={i} class={c.ok ? 'ok' : 'bad'}>
          <span class="ai-mark" aria-hidden="true">
            <Icon name={c.ok ? 'check' : 'alert'} size={16} stroke={2.6} />
          </span>
          <span class="stack-xs" style={{ gap: 0 }}>
            <span class="sr-only">{c.ok ? t('Lolos:', 'Passed:') : t('Tidak lolos:', 'Failed:')}</span>
            <span>{c.label}</span>
            {!c.ok && c.reason && <span class="label">{c.reason}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "Cara AI memproses ini": a link under an AI result; opens the steps and checks. */
export function AiHow({ trace, verify, onNavy = false }: { trace?: string; verify?: Verification | null; onNavy?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!trace && !verify) return null;
  return (
    <>
      <button type="button" class={`link-btn row ai-how-link${onNavy ? ' on-navy' : ''}`} style={{ gap: 8, alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        <Icon name="info" size={18} />
        {t('Cara AI memproses ini', 'How the AI handled this')}
      </button>
      {open && <AiHowSheet trace={trace} verify={verify ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

function AiHowSheet({ trace, verify, onClose }: { trace?: string; verify: Verification | null; onClose: () => void }) {
  const box = useRef<HTMLDialogElement | null>(null);
  const [data, setData] = useState<Trace | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    box.current?.showModal();
    if (trace) api.aiTrace(trace).then((r) => setData(r.trace), (e) => setError((e as Error).message));
  }, []);
  const checks = data?.verify ?? verify;
  return (
    <dialog ref={box} class="leave-check ai-how" aria-labelledby="ai-how-title" onCancel={(e) => (e.preventDefault(), onClose())}>
      <h2 id="ai-how-title">{t('Cara AI memproses ini', 'How the AI handled this')}</h2>
      {trace && !data && !error && <p class="ink2">{t('Memuat…', 'Loading…')}</p>}
      {error && <p class="ink2">{t('Langkah AI belum bisa dimuat. Hasil cek tetap di bawah.', 'The AI steps could not be loaded. The checks are still below.')}</p>}
      {data && (
        <div class="stack-xs">
          <span class="label strong">{t('Langkah', 'Steps')}</span>
          <ol class="ai-steps">
            {data.steps.map((s, i) => (
              <li key={i}>
                <span class="semi">{STEP[s.step]?.() ?? s.step}</span>
                <span class="label ink2">{[modelName(s.provider, s.model), s.calls > 1 ? t(`${s.calls} kali`, `${s.calls} times`) : '', secs(s.ms)].filter(Boolean).join(' · ')}</span>
                {OUTCOME[s.outcome] && <span class={`label semi ai-outcome ${s.outcome}`}>{OUTCOME[s.outcome]!()}</span>}
              </li>
            ))}
          </ol>
          <span class="label ink2">{t(`Total ${secs(data.ms)}`, `Total ${secs(data.ms)}`)}</span>
        </div>
      )}
      {checks && (
        <div class="stack-xs">
          <span class="label strong">{t('Dicek kode aplikasi', 'Checked by the app’s code')}</span>
          <Checks verify={checks} />
          {checks.status === 'failed' && (
            <span class="label ink2">{t('Yang tidak lolos tidak diisi otomatis: cek manual, atau aturan aplikasi yang dipakai.', 'What failed is not filled in: check it by hand, or the app rules are used.')}</span>
          )}
        </div>
      )}
      <button type="button" class="btn secondary" onClick={onClose}>
        {t('Tutup', 'Close')}
      </button>
    </dialog>
  );
}
