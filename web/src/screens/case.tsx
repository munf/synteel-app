// Dead-eel case (cases.ts on the server): the full card on the pond page, a short one (CaseBrief) on Beranda.
// Facts and decisions come from the rules (dead per day, rising compared with yesterday, re-check
// unanswered, close after 2 days without deaths); the case agent adds a short summary, what to
// watch, at most 2 questions and extra checks. Sending to the owner is always a manual WhatsApp tap.
import { useEffect, useState } from 'preact/hooks';
import { api, type CaseRun, type CaseView } from '../api.ts';
import type { Go } from '../app.tsx';
import { fmtClock } from '../labels.ts';
import { t } from '../i18n.ts';
import { Icon, Shape, Tick, type Tone } from '../ui.tsx';
import { SpeakToText } from './help.tsx';
import './case.css';

/** Open cases (and, for a pond, its closed ones). Polls every 3 seconds while the agent is working. */
export function useCases(pondId?: number, refreshKey?: unknown) {
  const [list, setList] = useState<CaseView[]>([]);
  const load = () => api.cases(pondId).then((r) => setList(r.cases), () => {});
  useEffect(() => {
    load();
  }, [pondId, refreshKey]);
  const running = list.some((c) => c.running);
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), running ? 3000 : 30_000);
    return () => clearInterval(timer);
  }, [pondId, running]);
  const replace = (c: CaseView) => setList((all) => all.map((x) => (x.id === c.id ? c : x)));
  return { list, replace, reload: load };
}

const TREND: Record<CaseView['trend'], { tone: Tone; word: string }> = {
  up: { tone: 'bad', word: t('Naik', 'Rising') },
  same: { tone: 'warn', word: t('Tetap', 'Steady') },
  down: { tone: 'ok', word: t('Turun', 'Falling') },
  first: { tone: 'blue', word: t('Hari pertama', 'First day') },
};

const eels = (n: number) => t(`${n} ekor`, `${n} ${n === 1 ? 'eel' : 'eels'}`);
/** "Sejak kemarin", "Sejak Rabu": only the relative words go lower case. */
const since = (label: string) => (/^(Hari ini|Kemarin|Today|Yesterday)$/.test(label) ? label.toLowerCase() : label);

function sourceLine(run: CaseRun) {
  const when = fmtClock(run.generatedAt);
  if (run.source === 'agent') return t(`Dari AI · ${when}`, `From the AI · ${when}`);
  if (run.source === 'mock') return t(`Mode contoh, bukan hasil AI · ${when}`, `Sample mode, not from the AI · ${when}`);
  return t(`Dari aturan · ${when}`, `From the rules · ${when}`);
}

/** One line per thing the case agent did, so the farmer and the owner can see why it says what it says. */
function stepLabel(step: CaseRun['steps'][number]) {
  switch (step.tool) {
    case 'get_case':
      return t('Melihat jumlah mati per hari dan jawaban petani', 'Looked at the dead per day and the farmer’s answers');
    case 'get_pond_logs':
      return t('Membaca catatan kolam 3 hari terakhir', 'Read the pond records of the last 3 days');
    case 'get_forecast':
      return t('Membaca perkiraan suhu air dan cuaca', 'Read the water temperature estimate and the weather');
    case 'search_guidance':
      return t(`Mencari panduan: “${step.args.query ?? ''}”`, `Searched the guidance: “${step.args.query ?? ''}”`);
    case 'ask_farmer':
      return t('Menyiapkan pertanyaan untuk petani', 'Prepared a question for the farmer');
    case 'add_check':
      return t('Menambah cek', 'Added a check');
    case 'draft_owner_message':
      return t('Menulis pesan untuk pemilik', 'Wrote the message for the owner');
    case 'submit_case_update':
      return t('Menyusun ringkasan kasus', 'Wrote the case summary');
    default:
      return step.tool;
  }
}

/** The agent's questions: tap a quick answer, or say or type another one. */
function Questions({ c, onSaved }: { c: CaseView; onSaved: (c: CaseView) => void }) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [typing, setTyping] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const answers = c.openQuestions.map((q) => ({ q: q.q, a: (picked[q.q] ?? '').trim() })).filter((x) => x.a);
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      onSaved((await api.answerCase(c.id, answers)).case);
      setPicked({});
      setTyping(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack" style={{ gap: 16 }}>
      {c.openQuestions.map((q, i) => {
        const value = picked[q.q] ?? '';
        const quick = q.answers.includes(value);
        return (
          <div class="stack-sm" key={q.q}>
            <span class="strong case-q">
              {c.openQuestions.length > 1 ? `${i + 1}. ` : ''}
              {q.q}
            </span>
            <div class="chips" role="group" aria-label={q.q}>
              {q.answers.map((a) => (
                <button type="button" key={a} class={`chip${value === a ? ' on' : ''}`} aria-pressed={value === a} onClick={() => (setPicked({ ...picked, [q.q]: value === a ? '' : a }), setTyping(null))}>
                  {value === a && <Tick />}
                  {a}
                </button>
              ))}
              <button type="button" class={`chip${typing === q.q || (value && !quick) ? ' on' : ''}`} aria-pressed={typing === q.q} onClick={() => setTyping(typing === q.q ? null : q.q)}>
                <Icon name="mic" size={18} />
                {t('Jawab lain', 'Other answer')}
              </button>
            </div>
            {typing === q.q && (
              <div class="field">
                <textarea rows={2} maxLength={300} value={quick ? '' : value} placeholder={t('Ketik atau bicara', 'Type or speak')} aria-label={q.q} onInput={(e) => setPicked({ ...picked, [q.q]: e.currentTarget.value })} />
                <SpeakToText onText={(text) => setPicked({ ...picked, [q.q]: text })} hint={t('Suara diubah jadi teks dulu. Periksa sebelum kirim.', 'The voice becomes text first. Check it before sending.')} />
              </div>
            )}
          </div>
        );
      })}
      <button class="btn primary" disabled={busy || answers.length === 0} onClick={send}>
        {busy ? t('Mengirim…', 'Sending…') : t('Kirim jawaban', 'Send answers')}
      </button>
      {error && <p class="error">{error}</p>}
    </div>
  );
}

export function CaseCard({ c, go, onChanged, onPond = false }: { c: CaseView; go: Go; onChanged: (c: CaseView) => void; onPond?: boolean }) {
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = c.run;
  const trend = TREND[c.trend];
  const days = c.days.slice(-4);
  const most = Math.max(1, ...days.map((d) => d.dead));
  const now = Date.now();
  const checks = run.checks.filter((k) => k.t >= now - 30 * 60_000).slice(0, 3);
  const act = (fn: () => Promise<{ case: CaseView }>) => async () => {
    setBusy(true);
    setError('');
    try {
      onChanged((await fn()).case);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card case-card" aria-label={t(`Kasus sidat mati ${c.pondName}`, `Dead eel case ${c.pondName}`)}>
      <div class="row top">
        <span class="icon-box bad">
          <Icon name="dead" />
        </span>
        <div class="stack-xs grow">
          <h2>{onPond ? t('Kasus sidat mati', 'Dead eel case') : t(`Kasus sidat mati ${c.pondName}`, `Dead eel case, ${c.pondName}`)}</h2>
          <span class="meta">
            {t('Sejak', 'Since')} {since(c.days[0].label)} · {eels(c.total)}
          </span>
        </div>
        <span class={`pill ${trend.tone}`}>
          <Shape tone={trend.tone} />
          {trend.word}
        </span>
      </div>

      {c.escalate && (
        <div class="case-escalate stack-sm" role="alert">
          {c.escalate.reasons.includes('rising') && <span class="strong">{t('Kematian naik dibanding kemarin.', 'Deaths are up compared with yesterday.')}</span>}
          {c.escalate.reasons.includes('recheck_missed') && c.recheck && (
            <span class="strong">{t(`Cek ulang jam ${fmtClock(c.recheck.dueAt)} belum dijawab.`, `The ${fmtClock(c.recheck.dueAt)} re-check has no answer yet.`)}</span>
          )}
          <a class="btn danger" href={c.escalate.waUrl} target="_blank" rel="noopener">
            <Icon name="chat" size={20} /> {t('Kirim ke pemilik', 'Send to the owner')}
          </a>
          <span class="label">
            {c.escalate.waUrl.includes('wa.me/?')
              ? t('Membuka WhatsApp dengan pesan siap kirim. Pilih kontak pemilik. Tidak terkirim sendiri.', 'Opens WhatsApp with the message ready. Choose the owner’s contact. Nothing is sent by itself.')
              : t(`Membuka WhatsApp ke ${c.escalate.ownerName} dengan pesan siap kirim. Tidak terkirim sendiri.`, `Opens WhatsApp to ${c.escalate.ownerName} with the message ready. Nothing is sent by itself.`)}
          </span>
        </div>
      )}

      <div class="case-days" role="list" aria-label={t('Sidat mati per hari', 'Dead eels per day')}>
        {days.map((d) => (
          <div class="case-day" role="listitem" key={d.date}>
            <span class="case-day-name">{d.label}</span>
            <span class="case-bar" aria-hidden="true">
              {d.dead > 0 && <span style={{ width: `${Math.max(8, (d.dead / most) * 100)}%` }} />}
            </span>
            <span class={`case-day-n num${d.dead > 0 ? ' strong' : ' ink2'}`}>{d.dead > 0 || d.recorded ? eels(d.dead) : t('belum dicatat', 'not recorded')}</span>
          </div>
        ))}
      </div>

      <div class="box stack-sm">
        <span class="label ink2">{c.running ? t('AI sedang membaca kasus…', 'The AI is reading the case…') : sourceLine(run)}</span>
        <p>{run.summary}</p>
        {onPond && run.watch.length > 0 && (
          <div class="stack-xs">
            <span class="label strong">{t('Yang perlu diawasi', 'What to watch')}</span>
            <ul class="case-watch">
              {run.watch.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        {onPond && run.steps.length > 0 && (
          <>
            <button type="button" class="link-btn row" style={{ gap: 8, alignSelf: 'flex-start' }} aria-expanded={steps} onClick={() => setSteps(!steps)}>
              {t(`Yang dilihat AI (${run.steps.length} langkah)`, `What the AI looked at (${run.steps.length} ${run.steps.length === 1 ? 'step' : 'steps'})`)}
              <span style={{ display: 'flex', transform: steps ? 'rotate(180deg)' : 'none' }}>
                <Icon name="down" size={18} />
              </span>
            </button>
            {steps && (
              <ol class="case-steps">
                {run.steps.map((s, i) => (
                  <li key={i}>{stepLabel(s)}</li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>

      {c.openQuestions.length > 0 && !c.running && <Questions key={run.generatedAt} c={c} onSaved={onChanged} />}

      {onPond && c.answers.length > 0 && (
        <div class="stack-xs">
          <span class="label strong">{t('Jawaban petani', 'Farmer’s answers')}</span>
          {c.answers.slice(-4).map((a, i) => (
            <span class="label ink2" key={i}>
              {fmtClock(Date.parse(a.at))} · {a.q} <span class="semi" style={{ color: "var(--ink)" }}>{a.a}</span>
            </span>
          ))}
        </div>
      )}

      {checks.length > 0 && (
        <div class="stack-xs">
          <span class="label strong">{onPond ? t('Cek berikutnya', 'Next checks') : t('Cek berikutnya', 'Next check')}</span>
          {(onPond ? checks : checks.slice(0, 1)).map((k) => (
            <div class="case-check" key={`${k.t}-${k.action}`}>
              <span class="strong num">{fmtClock(k.t)}</span>
              <span class="grow">{k.action}</span>
              {k.source === 'agent' && <span class="soon">{t('dari AI', 'from AI')}</span>}
            </div>
          ))}
        </div>
      )}

      {c.closeSuggested && (
        <div class="note ok" style={{ alignItems: 'center', flexDirection: 'column', gap: 12 }}>
          <span class="row" style={{ gap: 8, alignSelf: 'stretch' }}>
            <Icon name="check" />
            <span class="strong grow">{t('2 hari tanpa sidat mati. Tutup kasus ini?', '2 days without dead eels. Close this case?')}</span>
          </span>
          <button class="btn primary" style={{ alignSelf: 'stretch' }} disabled={busy} onClick={act(() => api.closeCase(c.id))}>
            {t('Ya, tutup kasus', 'Yes, close the case')}
          </button>
        </div>
      )}

      {c.canMarkNoDead && (
        <button class="btn secondary" disabled={busy} onClick={act(() => api.noDeadToday(c.id))}>
          {t('Hari ini tidak ada yang mati', 'None dead today')}
        </button>
      )}

      <div class="case-links">
        <button type="button" class="link-row" onClick={() => go({ name: 'problem', pondId: c.pondId })}>
          {t('Lapor sidat mati lagi', 'Report more dead eels')} <Icon name="next" size={20} />
        </button>
        {!onPond && (
          <button type="button" class="link-row" onClick={() => go({ name: 'pond', id: c.pondId })}>
            {t('Lihat kasus lengkap', 'See the full case')} <Icon name="next" size={20} />
          </button>
        )}
      </div>
      {error && <p class="error">{error}</p>}
      <span class="label ink2">{t('Saran, bukan diagnosis. Aplikasi ini tidak memberi obat atau dosis.', 'Advice, not a diagnosis. This app does not give medicine or doses.')}</span>
    </section>
  );
}

/** "Hari ini 8 ekor, kemarin 6": the last two days of the case in one line. */
function stateLine(c: CaseView) {
  const [prev, last] = c.days.length > 1 ? c.days.slice(-2) : [null, c.days[0]];
  const n = (d: CaseView['days'][number]) => (d.dead > 0 || d.recorded ? eels(d.dead) : t('belum dicatat', 'not recorded'));
  // A day and its number stay on one line.
  const first = `${last.label}\u00a0${n(last).replace(' ', '\u00a0')}`;
  return prev ? `${first}, ${since(prev.label)}\u00a0${prev.dead > 0 || prev.recorded ? prev.dead : n(prev)}` : first;
}

/** The case on Beranda: only what is needed now. Questions, the days, what the AI looked at and the
 *  check times are on the pond page (CaseCard with onPond). */
export function CaseBrief({ c, go }: { c: CaseView; go: Go }) {
  const trend = TREND[c.trend];
  const asked = c.running ? 0 : c.openQuestions.length;
  return (
    <section class="card case-card case-brief" aria-label={t(`Kasus sidat mati ${c.pondName}`, `Dead eel case ${c.pondName}`)}>
      <div class="row top">
        <span class="icon-box bad">
          <Icon name="dead" />
        </span>
        <div class="stack-xs grow">
          <h2>{t(`Kasus sidat mati ${c.pondName}`, `Dead eel case, ${c.pondName}`)}</h2>
          <span class="meta num">{stateLine(c)}</span>
        </div>
        <span class={`pill ${trend.tone}`}>
          <Shape tone={trend.tone} />
          {trend.word}
        </span>
      </div>

      <div class="stack-xs">
        <span class="label ink2">{c.running ? t('AI sedang membaca kasus…', 'The AI is reading the case…') : sourceLine(c.run)}</span>
        <p class="case-brief-sum">{c.run.summary}</p>
      </div>

      {c.escalate && (
        <div class="stack-xs">
          <a class="btn danger" href={c.escalate.waUrl} target="_blank" rel="noopener">
            <Icon name="chat" size={20} /> {t('Kirim ke pemilik', 'Send to the owner')}
          </a>
          {c.escalate.reasons.includes('recheck_missed') && c.recheck && (
            <span class="label ink2">
              {t(`Cek ulang jam ${fmtClock(c.recheck.dueAt)} belum dijawab.`, `The ${fmtClock(c.recheck.dueAt)} re-check has no answer yet.`)}
            </span>
          )}
        </div>
      )}

      <div class="case-links">
        {asked > 0 && (
          <span class="case-asked label semi">
            <Icon name="chat" size={18} />
            {t(`${asked} pertanyaan menunggu jawaban`, `${asked} ${asked === 1 ? 'question is' : 'questions are'} waiting for an answer`)}
          </span>
        )}
        <button type="button" class="link-row" onClick={() => go({ name: 'pond', id: c.pondId })}>
          {t('Lihat kasus lengkap', 'See the full case')} <Icon name="next" size={20} />
        </button>
      </div>
    </section>
  );
}

/** Closed cases of a pond, one line each. */
export function ClosedCases({ list }: { list: CaseView[] }) {
  if (!list.length) return null;
  return (
    <section class="card" style={{ gap: 8 }}>
      <h2>{t('Kasus sebelumnya', 'Earlier cases')}</h2>
      {list.map((c) => (
        <div class="list-row" key={c.id}>
          <span class="pill ok">
            <Shape tone="ok" />
            {t('Selesai', 'Closed')}
          </span>
          <span class="grow stack-xs">
            <span class="strong">{eels(c.total)}</span>
            <span class="label ink2">
              {c.days[0].label} – {c.days.at(-1)!.label}
            </span>
          </span>
        </div>
      ))}
    </section>
  );
}
