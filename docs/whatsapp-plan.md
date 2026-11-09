# WhatsApp delivery: what is built, what the privacy text needs, what the owner must set up

Status, 10 November 2026: the code is in the app ([`server/src/whatsapp.ts`](../server/src/whatsapp.ts), Profil → **Kirim langkah lewat WhatsApp**, Problem flow → **Kirim langkah lewat WhatsApp**). No WhatsApp account exists yet and no credentials are on the server, so the app runs in **link** mode: nothing is sent by the server. The privacy and terms changes below are drafts only; the live Syarat (`TERMS_VERSION` 2026-11-01) and the privacy page are unchanged.

## What is built

| Part | What it does |
|---|---|
| Providers | One interface, three providers. **cloud**: Meta WhatsApp Cloud API, `POST https://graph.facebook.com/<version>/<WHATSAPP_PHONE_NUMBER_ID>/messages`, an approved template for messages the server starts, free text only inside the 24-hour window after the farmer last wrote to the business number. **link**: no account; the phone opens `wa.me/<number>?text=…` and the farmer sends it. **mock**: keeps messages in memory for tests and local QA (`SYNTEEL_WHATSAPP_MOCK=1`). |
| Selection | cloud only when `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are set (see `.env.example`), else mock when asked, else link. The server log says which one at start-up. |
| What is sent | Tonight's check plan after the evening run (17.00 local time): times, ponds, which checks ring as an alarm. A danger summary when the monitor sees a pond's risk rise to danger (fixed rules), at most once per pond per farmer per 6 hours. The Problem flow's steps when the farmer taps the button. |
| Language | The farmer's app language (Indonesian or English). The app has no Javanese interface text, so messages have none either. |
| Checked content only | Messages hold the rules' schedule and reasons, the SOP steps shown on the phone, readings the farmer saved and the dead count the farmer entered. A value held back as **Cek manual** never goes in (`stepsMessage` drops held values; tests check it). A step that reads like medicine, a dose or a diagnosis is dropped. No model writes any message, and a test checks that `whatsapp.ts` cannot reach a model module. |
| The phone alarm stays first | WhatsApp is an extra channel. The alarm path (rules, nowcast, monitor, the phone alarm) does not wait for it, and a WhatsApp failure changes nothing there. |
| Farmer settings (Profil) | WhatsApp number (may differ from the sign-in number), verification state, the opt-in switch, which messages (steps, night plan, danger summary) and a consent tick. Without the Cloud API the night plan and danger summary show as "Belum aktif di server ini". |
| Number check | With the Cloud API: a 6-digit code through the authentication template, valid 10 minutes, 5 tries, 5 codes an hour. A new number is unverified again. In link mode no check is possible or needed: the farmer sends from their own phone. |
| Gating | The server sends only with a push channel, the opt-in on, the current WhatsApp consent (`WA_CONSENT_VERSION`), a number, the number verified and that message kind chosen. Otherwise the steps button opens WhatsApp on the phone. |
| Record of sends | Table `wa_sends`: time, person, farm, pond, kind, channel, template name, status, error status line, WhatsApp message id. Never the message text and never the number. Profil shows the last send. Deleting the account deletes the settings and the sends. |

Not built yet: the webhook for delivery receipts and replies (so "sent" means accepted by the API, not read), inbound "Kode Synteel" messages (the farmer-initiated check from the security notes), and forwarding to the owner (the existing owner buttons still open WhatsApp on the phone).

## Does the privacy text need a change? Yes, before the Cloud API is turned on

Today the privacy policy (section 5) says WhatsApp is used "only when the user taps a share button … the user decides whether to send it". With the Cloud API, Synteel itself sends the farmer's WhatsApp number and the message text to Meta (WhatsApp Business Platform), possibly outside Indonesia, and keeps a log of sends. That is a new recipient and a new purpose, so the policy must say so before the first real message. Link mode alone does not need a change (it is what the current text describes), but the new Profil fields store a WhatsApp number on the server, which section 2 should list.

Draft changes (source: `/root/synteel-design/cap/site/privasi/build.py`, which also writes `web/src/privacy.json`; not applied):

- **2. Data yang dikumpulkan**, new heading "WhatsApp":
  - ID: "Nomor WhatsApp yang diisi di Profil (boleh beda dengan nomor masuk), apakah nomor itu sudah dicek dengan kode, pesan apa saja yang dipilih, dan kapan persetujuan WhatsApp diberikan. Untuk tiap pesan yang dikirim Synteel mencatat jenis pesan, waktu, nama template dan berhasil tidaknya, tanpa isi pesan dan tanpa nomor."
  - EN: "The WhatsApp number entered in Profil (it can differ from the sign-in number), whether it was checked with a code, which messages were chosen, and when the WhatsApp consent was given. For each message sent, Synteel logs its kind, time, template name and whether it went through, without the text and without the number."
- **3. Untuk apa data dipakai**, new item: "Mengirim langkah, rencana cek malam dan ringkasan tanda bahaya ke WhatsApp pengguna, hanya kalau pengguna menyalakannya di Profil. Alarm di HP tetap yang utama." / "Sending steps, tonight's check plan and danger summaries to the user's WhatsApp, only when the user turns it on in Profil. The phone alarm stays the main signal."
- **5. Pihak lain yang menerima data**, replace the WhatsApp item:
  - ID: "<b>WhatsApp</b> (Meta Platforms): kalau pengguna menyalakan Kirim langkah lewat WhatsApp di Profil, Synteel mengirim nomor WhatsApp itu dan isi pesan (langkah, jam cek, nama kolam, angka catatan yang sudah disimpan) lewat WhatsApp Business Platform. Kalau tidak, aplikasi hanya membuka WhatsApp dengan teks yang sudah terisi dan pengguna sendiri yang mengirim."
  - EN: "<b>WhatsApp</b> (Meta Platforms): when the user turns on Send steps on WhatsApp in Profil, Synteel sends that WhatsApp number and the message (steps, check times, pond names, saved readings) through the WhatsApp Business Platform. Otherwise the app only opens WhatsApp with the text filled in and the user sends it."
  - The sentence "Synteel tidak pernah mengirim nama atau nomor HP akun ke layanan AI" stays true (WhatsApp is not an AI service and gets no account name), but should not be read as covering WhatsApp: add "Nomor WhatsApp hanya dikirim ke WhatsApp untuk pesan yang dipilih." / "The WhatsApp number only goes to WhatsApp, for the chosen messages."
- **8. Berapa lama data disimpan**, new item: "Pengaturan dan catatan kiriman WhatsApp: selama akun masih ada; mematikan WhatsApp di Profil menghentikan kiriman." / "WhatsApp settings and the log of sends: while the account exists; turning WhatsApp off in Profil stops the messages."
- Raise the date at the top and, per section 13, announce it in the app.

**Syarat dan Ketentuan** (source `/root/synteel-design/cap/site/syarat/build.py`): Pasal 11 (1) already refers to third-party providers "sebagaimana disebut dalam Kebijakan Privasi", and the in-app WhatsApp consent is separate and versioned (`WA_CONSENT_VERSION` in `whatsapp.ts`), so the terms need no change for WhatsApp to work. One clarity addition is advised for the next terms version, not now: Pasal 5 new paragraph (4) "Pesan WhatsApp dari Synteel adalah saluran tambahan. Pesan bisa terlambat atau tidak sampai, dan tidak menggantikan alarm di HP atau pemeriksaan kolam secara langsung." / "WhatsApp messages from Synteel are an extra channel. They can be late or not arrive, and they do not replace the phone alarm or checking the ponds in person." Adding it is a substantive change: raise `TERMS_VERSION` and give the 14 days' notice of Pasal 17.

## What the owner must do to turn on the Cloud API

1. **Meta Business account** (business.facebook.com) for PT Synt Tekno Multikarya, and **business verification** of the PT. Meta asks for the legal name, address and a document showing them; the AHU decree may do, the NIB is not issued yet (see the legal-entity notes). Without verification the number has low daily limits and cannot pass a display name review.
2. **A WhatsApp Business number**: a dedicated Indonesian number that is not in use on the WhatsApp or WhatsApp Business app (a new SIM is simplest). Add it in a Meta developer app with the WhatsApp product, verify it by SMS or call, and get the **display name** ("Synteel") approved.
3. **A permanent token**: a system user in Business Settings with `whatsapp_business_messaging` (and `whatsapp_business_management` to manage templates), and its token. Note the **phone number ID** (not the phone number) from the WhatsApp → API setup page.
4. **Templates** to submit for approval, in Indonesian (`id`) and English (`en`), category **Utility** for the first three and **Authentication** for the code. Body texts that match the parameters the app sends:
   - `synteel_rencana_malam`: "Rencana cek malam ini di {{1}}: {{2}}. Alarm di HP tetap berbunyi seperti biasa." / "Tonight's check plan at {{1}}: {{2}}. The alarm on the phone still rings as usual."
   - `synteel_tanda_bahaya`: "Tanda bahaya di {{1}}, {{2}}: {{3}}. Cek kolam sekarang. Alarm di HP tetap yang utama." / "Danger sign at {{1}}, {{2}}: {{3}}. Check the pond now. The alarm on the phone comes first."
   - `synteel_langkah`: "Langkah untuk {{1}}, {{2}}: {{3}}" / "Steps for {{1}}, {{2}}: {{3}}"
   - `synteel_kode`: Meta's authentication template with a copy-code button (Meta writes the body; the app sends the code as {{1}} and on the button).
   Meta may move a template to another category on review; check the category it lands in, since the price follows it.
5. **Put the values in `/root/.synteel.env`** on the server (never in the repo): `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and the `WHATSAPP_TEMPLATE_*` names (all names are in `.env.example`). Restart the service; the log then says "WhatsApp: Cloud API". Send one test to the owner's own number first.
6. **Update the privacy policy** as drafted above before the first farmer turns it on.
7. Optional, later: a webhook URL in the Meta app for delivery receipts and replies, which would also allow the farmer-initiated "Kode Synteel" check and free-text replies inside the 24-hour window.

An alternative from the earlier security notes is **Kapso** (kapso.ai), which sits on top of the same Meta platform (2,000 messages a month on its free plan, Meta's fees separate, its ready-made number US-only). The app would need a Kapso provider next to `cloudProvider`; the rest stays the same.

## Costs (Meta's per-message pricing)

Read on 10 November 2026 from Meta's pricing page, https://developers.facebook.com/docs/whatsapp/pricing:

- Since 1 July 2025 Meta charges **per delivered message**, not per conversation. Each message has one price set by its **category** (marketing, utility, authentication; service for free text) and the recipient's country. Messages from users to the business are free.
- **Service messages** (free text inside the 24-hour window): the first 1,000 per business number per month are free; from 1 October 2026 Meta charges for those beyond that.
- **Utility templates sent inside an open 24-hour window** were free from 1 July 2025; Meta charges for them again from 1 October 2026.
- Indonesia (+62) is its own market on the rate card, and IDR can be the billing currency. **The Indonesian per-message rates could not be read** (they are in Meta's rate-card CSV and the interactive table on whatsappbusiness.com/products/platform-pricing): **unverified**, look them up before turning it on.

What this app would send per farmer who turns everything on: about one night plan a day (utility), a danger summary only on danger nights (utility, at most one per pond per 6 hours), steps only when the farmer taps the button (utility), and one code per number check (authentication). No marketing messages.
