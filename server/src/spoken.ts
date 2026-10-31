// "Dengarkan" on Waspada: Muse Spark rewrites the screen's text (headline, reasons, night summary,
// next check) as plain spoken Indonesian, so the phone's voice reads one flowing explanation instead
// of joined fragments. The guard keeps it to the same facts: no new numbers, every clock time kept,
// no treatment or diagnosis words, never an oxygen figure. Anything it refuses falls back to the text as given.
import { createHash } from 'node:crypto';
import { call, Retry, type ChatProvider } from './ai.ts';
import { unsafeText } from './agentloop.ts';
import { currentLang } from './i18n.ts';
import { numbersOk } from './patterns.ts';

export const SPOKEN_MAX_INPUT = 1500;

export type Spoken = { text: string; source: 'agent' | 'rules' };

const SYSTEM = () =>
  currentLang() === 'en'
    ? [
        'You turn the text of an eel farm\'s night watch screen into what a calm farm helper would say out loud to the farmer.',
        'Rules:',
        '- Keep every fact and nothing more: the same numbers, pond names and times. Do not add numbers, causes, advice or reassurance that is not in the text.',
        '- Natural spoken English, short sentences, 3 to 6 sentences. No lists, no headings, no symbols.',
        '- Tell it like talking: how tonight looks, then why (everything after "Reasons" is a cause, not a result), then what to check and when. Spoken links: "because" for causes, "later" for the next check.',
        '- Say times as written (for example 21:00). Never mention oxygen levels, disease, medicine or doses.',
        'Answer with JSON {"text": "..."} only.',
      ].join('\n')
    : [
        'Kamu mengubah teks layar Waspada malam tambak sidat menjadi ucapan seorang pendamping tambak yang tenang kepada petani.',
        'Aturan:',
        '- Pertahankan semua fakta dan jangan menambah: angka, nama kolam dan jam tetap sama. Jangan menambah angka, sebab, saran atau kalimat menenangkan yang tidak ada di teks.',
        '- Bahasa Indonesia lisan sehari-hari yang sopan, kalimat pendek, 3 sampai 6 kalimat. Tanpa daftar, judul atau simbol.',
        '- Susun seperti orang bercerita: keadaan malam ini, lalu sebabnya (semua yang ada sesudah "Alasannya" adalah sebab, bukan akibat), lalu yang perlu dicek dan jamnya. Kata penghubung lisan: "soalnya" untuk sebab, "nanti" untuk cek berikutnya.',
        '- Tanpa kata ganti orang (saya, kamu, Anda) dan tanpa singkatan kecuali pH dan TDS.',
        '- Jam ditulis seperti di teks (misalnya 21.00). Desimal pakai koma. Jangan menyebut kadar oksigen, penyakit, obat atau dosis.',
        'Jawab hanya JSON {"text": "..."}.',
      ].join('\n');

const SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };

/** Numbers in a text, as numbers ("29,8" → 29.8). */
const numbers = (text: string) => [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.')));
/** Clock times in a text ("21.00", "21:00") as "21:00". */
const times = (text: string) => [...text.matchAll(/\b(\d{1,2})[.:](\d{2})\b/g)].map((m) => `${m[1].padStart(2, '0')}:${m[2]}`);

/** The rewrite, or null when it adds or drops facts. */
export function guardSpoken(original: string, proposal: unknown): string | null {
  const text = String(proposal ?? '').trim().replace(/\s+/g, ' ');
  if (text.length < 20 || text.length > Math.max(400, original.length * 1.6)) return null;
  if (unsafeText(text) || /oksigen|oxygen|\bDO\b|mg\/l/i.test(text)) return null;
  // Numbers: only ones the screen already says (times split into hour and minute count too).
  const allowed = [...numbers(original), ...times(original).flatMap((t) => t.split(':').map(Number))];
  if (!numbersOk(text, allowed)) return null;
  // Every clock time on the screen (the next check above all) is still said.
  const said = new Set(times(text));
  if (!times(original).every((t) => said.has(t))) return null;
  if (currentLang() === 'id' && /\b(saya|aku|kamu|anda)\b/i.test(text)) return null;
  return text;
}

/** One rewrite per text and language, kept in memory: every phone on the farm hears the same words. */
export function spokenWriter(providers: ChatProvider[], max = 500) {
  const cache = new Map<string, Spoken>();
  return async (original: string): Promise<Spoken> => {
    const key = createHash('sha256').update(`${currentLang()}\0${original}`).digest('hex');
    const hit = cache.get(key);
    if (hit) return hit;
    let result: Spoken = { text: original, source: 'rules' };
    for (const p of providers) {
      try {
        const body = await call(`${p.base}/chat/completions`, p.apiKey, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: p.model,
            messages: [
              { role: 'system', content: SYSTEM() },
              { role: 'user', content: original },
            ],
            response_format: { type: 'json_schema', json_schema: { name: 'spoken', strict: true, schema: SCHEMA } },
            max_tokens: 1500,
            reasoning_effort: 'low',
          }),
        });
        const text = guardSpoken(original, JSON.parse(body.choices?.[0]?.message?.content ?? '{}').text);
        if (text) result = { text, source: 'agent' };
        else console.warn(`spoken: rewrite refused: ${String(body.choices?.[0]?.message?.content ?? '').slice(0, 300)}`);
        break;
      } catch (err) {
        console.error(`spoken ${p.name}: ${(err as Error).message}`);
        // Outage or overload: try the next provider. Anything else: read the text as given.
        if (!(err instanceof Retry)) break;
      }
    }
    if (cache.size >= max) cache.delete(cache.keys().next().value!);
    // Only good rewrites are kept, so a passing outage is tried again on the next tap.
    if (result.source === 'agent') cache.set(key, result);
    return result;
  };
}
