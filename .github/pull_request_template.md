## What changes for the farmer

<!-- One or two sentences in plain words: what the farmer or worker sees or can do now. "Nothing" is a fine answer for tooling. -->

## How it was checked

- [ ] `npm test` (number of tests: )
- [ ] `npx tsc --noEmit -p web`
- [ ] `npm run build`
- [ ] `npm run eval` (and `npm run eval -- bench --mock` if the AI path changed)
- [ ] New logic has a test in `server/test/`

## Screenshots

<!-- Phone width (390 × 844), Indonesian and English, for every screen that changed. Mock or demo data is labelled. -->

## AI calls made

<!-- Real model calls while building or checking this change: provider, model, how many, and why. "None (mock only)" if none. -->

## Safety and privacy

- [ ] Alarms still come from the fixed rules only, with no model on that path
- [ ] No keys, env files, databases or partner farm photos in the diff
- [ ] No invented farmer, field or revenue numbers
