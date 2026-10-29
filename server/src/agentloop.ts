// What the evening briefing agent and the dead-eel case agent share: the tool-calling loop over
// the providers (open-weight Muse Spark Open first, then the Meta API, then Fireworks), the
// knowledge search tool, and the text guard. Each agent keeps its own tools, prompt and guard
// for what it submits; this file only runs the conversation.
import { currentLang } from './i18n.ts';
import { AiFailed, call, Retry, type ChatProvider } from './ai.ts';
import { knowledge } from './knowledge.ts';

export type Step = { tool: string; args: Record<string, unknown> };

// Medicines and doses are out of scope for the app; anything that sounds like treatment is dropped.
const TREATMENT =
  /\b(obat|antibiotik|antibiotic|dosis|dosage|dose|takaran|formalin|metilen|methylene|malachite|kalium permanganat|permanganate|\bpk\b|oxytetra|tetrasiklin|tetracycline|enrofloxacin|vaksin|vaccine|suntik|inject|medicine|medication|garam\s+\d|(mandi|rendam)\w*\s+(garam|obat)|salt\s+(bath|dip)|mg\/l\s+(obat|garam)|ppm\s+(obat|garam)|\d+\s*(mg|ml|gram|g)\s*(per|\/)\s*(l|liter|kg|m3|ton))/i;

// No diagnosis: no disease or pathogen named as the answer, no "the eels have X".
// "bukan diagnosis" / "not a diagnosis" (a hedge) is allowed.
const DIAGNOSIS =
  /((?<!(bukan|not a|no)\s)diagnos|terinfeksi|infeksi|infected|infection|terserang|terjangkit|terkena\s+(penyakit|jamur|infeksi|kutu|cacing)|\bdisease\b|virus|bakteri|bacteria|parasit|aeromonas|edwardsiella|pseudomonas|vibrio|saprolegni|ichthyophthir|white\s*spot|bintik\s+putih|trichodina|dactylogyr|gyrodactyl|columnaris|flavobacter|anguillicol|herpes|anghv|evex|dropsy|septi[ck]?a?emia|septikemia|red\s+(fin|pest)|sirip\s+merah|busuk\s+insang|gill\s+rot)/i;

/** Text the app may not show: medicine, doses, or a diagnosis. */
export const unsafeText = (text: string) => TREATMENT.test(text) || DIAGNOSIS.test(text);

/** "21.30" (id) or "21:30" (en) in the farm's time zone. */
export const clock = (t: number, tz: string) => {
  const hm = new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return currentLang() === 'en' ? hm : hm.replace(':', '.');
};

/** The farm's part of the day at `t`, for the prompt: time words in the text must follow it. */
export function partOfDay(t: number, tz: string): string {
  const h = Number(new Date(t).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: tz })) % 24;
  const [id, en] = h >= 4 && h < 10 ? ['pagi', 'morning'] : h < 15 && h >= 10 ? ['siang', 'midday'] : h >= 15 && h < 18 ? ['sore', 'afternoon'] : ['malam', 'night'];
  return currentLang() === 'en' ? en : id;
}

// Rain words follow the amount per hour (BMKG-style bands): below 2.5 mm light, up to 7.6 mm moderate, above heavy.
export const HEAVY_RAIN_MM = 7.6;

/** Wording rules both agents follow (learned from live runs): rain by amount, oxygen as an estimate, time words by the clock. */
export const wordingRules = (now: number, tz: string): string[] =>
  currentLang() === 'en'
    ? [
        `- It is now ${clock(now, tz)} (${partOfDay(now, tz)}) at the farm. Words like "tonight", "this morning", "this afternoon" must fit that time.`,
        `- Rain words follow the amount per hour: under 2.5 mm light rain, 2.5–${HEAVY_RAIN_MM} mm moderate rain, only above ${HEAVY_RAIN_MM} mm heavy rain.`,
        '- Oxygen in the water is not measured: it is only the app\'s estimate. Write "estimated oxygen is low" or "oxygen risk is rising", never "oxygen is very low" as a fact.',
      ]
    : [
        `- Sekarang jam ${clock(now, tz)} (${partOfDay(now, tz)}) di tambak. Kata waktu seperti "malam ini", "pagi ini", "sore ini" harus sesuai jam itu.`,
        `- Kata hujan mengikuti jumlahnya per jam: di bawah 2,5 mm hujan ringan, 2,5–7,6 mm hujan sedang, hanya di atas ${String(HEAVY_RAIN_MM).replace('.', ',')} mm hujan deras.`,
        '- Oksigen air tidak diukur, hanya perkiraan aplikasi. Tulis "perkiraan oksigen rendah" atau "risiko oksigen naik", jangan "oksigen air sangat rendah" seperti fakta.',
      ];

const HEAVY_RAIN = /\b(hujan\s+(sangat\s+)?(deras|lebat)|heavy\s+rain|downpour)/i;
// Oxygen stated as a measured fact; "perkiraan/risiko oksigen" and "estimated oxygen" are fine.
const OXYGEN_FACT = /(?<!(perkiraan|risiko|estimasi|kemungkinan|estimated|likely)\s)(oksigen(\s+(di\s+)?air)?\s+(sudah\s+|sangat\s+|terlalu\s+)?(rendah|habis|kurang|turun)|\boxygen(\s+in\s+the\s+water)?\s+(is\s+)?(very\s+|too\s+)?(low|dropping|gone))/i;

/** Text that says more than the data: heavy rain when the forecast is not heavy, or oxygen as if it were measured. */
export function overstated(text: string, weather: { rain: number }[]): boolean {
  const maxRain = Math.max(0, ...weather.map((h) => h.rain));
  return (HEAVY_RAIN.test(text) && maxRain <= HEAVY_RAIN_MM) || OXYGEN_FACT.test(text);
}

/** A tool definition in the OpenAI-compatible shape both providers take. */
export const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

/** Official guidance (emergency SOPs, thresholds, the nursery program, daily SOPs) matching the words of a query. */
export function searchGuidance(query: string) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const docs: { source: string; text: string }[] = [
    ...(knowledge.emergencies as any).emergencies.map((e: any) => ({ source: 'SOP darurat', text: `${e.trigger}: ${e.operator_actions.join('; ')}` })),
    ...(knowledge.thresholds as any).parameters.filter((p: any) => p.operator_action).map((p: any) => ({ source: 'Ambang batas', text: `${p.name}: ${p.operator_action}` })),
    ...(knowledge.nurseryProgram as any).stages.map((s: any) => ({ source: 'Program pembesaran', text: `Minggu ${s.weeks.join('–')} ${s.name}: pakan ${s.feed}; air ${s.water}` })),
    ...(knowledge.sop as any).tasks.map((t: any) => ({ source: 'SOP harian', text: `${t.task}${t.note ? ` (${t.note})` : ''}` })),
  ];
  return docs
    .map((d) => ({ ...d, score: words.filter((w) => d.text.toLowerCase().includes(w)).length }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ source, text }) => ({ source, text }));
}

/** One conversation with one provider: answers the read tools, collects the action tools, builds the result on submit. */
export interface Session<T> {
  run(name: string, args: Record<string, any>): unknown;
  finish(args: Record<string, any>, steps: Step[], model: string): T;
}

export interface LoopOptions<T> {
  /** For the server log: "briefing agent", "case agent". */
  label: string;
  system: string;
  user: string;
  tools: unknown[];
  /** The tool that ends the run. */
  submit: string;
  maxRounds?: number;
  /** A fresh session per provider, so a half-finished attempt leaves nothing behind. */
  session: () => Session<T>;
}

/**
 * Tries each provider in order until one calls the submit tool. Returns its result, or null with
 * the steps of the last attempt when every provider failed (the caller then answers from rules).
 */
export async function toolLoop<T>(providers: ChatProvider[], o: LoopOptions<T>): Promise<{ result: T | null; steps: Step[] }> {
  let steps: Step[] = [];
  for (const provider of providers.filter((p) => p.apiKey)) {
    steps = [];
    const result = await attempt(provider, steps);
    if (result !== null) return { result, steps };
  }
  return { result: null, steps };

  async function attempt(provider: ChatProvider, steps: Step[]): Promise<T | null> {
    const session = o.session();
    const messages: any[] = [
      { role: 'system', content: o.system },
      { role: 'user', content: o.user },
    ];
    try {
      for (let round = 0; round < (o.maxRounds ?? 8); round++) {
        const body = await call(`${provider.base}/chat/completions`, provider.apiKey, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: provider.model, messages, tools: o.tools, tool_choice: 'auto', max_tokens: 3000, reasoning_effort: 'low' }),
        });
        const msg = body.choices?.[0]?.message;
        if (!msg) throw new AiFailed('empty answer');
        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
        const calls: any[] = msg.tool_calls ?? [];
        if (!calls.length) {
          messages.push({ role: 'user', content: `Kirim hasilnya lewat ${o.submit}.` });
          continue;
        }
        for (const c of calls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(c.function?.arguments || '{}');
          } catch {
            // keep empty args; the tool answers with an error
          }
          if (c.function?.name === o.submit) {
            steps.push({ tool: o.submit, args: {} });
            return session.finish(args, steps, `${provider.name}/${provider.model}`);
          }
          steps.push({ tool: c.function?.name ?? '?', args });
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(session.run(c.function?.name, args)) });
        }
      }
      console.error(`${o.label} (${provider.name}): no ${o.submit} after`, o.maxRounds ?? 8, 'rounds');
    } catch (err) {
      if (!(err instanceof AiFailed || err instanceof Retry)) throw err;
      console.error(`${o.label} (${provider.name}):`, (err as Error).message);
    }
    return null;
  }
}
