# Contributing

Synteel is built by PT Synt Tekno Multikarya for Indonesian eel farmers. Changes come as pull requests against `main`.

**Set up.** Node.js 24 or newer, then `npm install`. No key is needed: `SYNTEEL_AI_MOCK=1` gives labelled example drafts for every AI step. [Run locally](README.md#run-locally) has the commands.

**Before a pull request**, run these one after another:

```sh
npm test
npx tsc --noEmit -p web
npm run build
npm run eval
```

CI runs the same on every pull request. New server logic gets a test in `server/test/`.

**Rules that keep farmers safe:**

- Alarms come from the fixed rules in `server/src/rules.ts`, `nowcast.ts` and `monitor.ts`. They must work with no internet and no AI. Never put a model on that path.
- AI output is a draft. It passes the code checks (`verify.ts`) and the farmer confirms it before it is saved.
- Never invent farmer, field or revenue numbers. Mock and example data are labelled as such in the app and the docs.
- Keys live outside the repo (`~/.synteel.env` or `.env`, both ignored). Never commit keys, env files, databases or photos from partner farms.

**App text** comes in Indonesian and English (`web/src/i18n.ts`). Indonesian copy uses no pronouns and no abbreviations except pH, TDS and AI.
