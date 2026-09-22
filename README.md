# Litmus

**A fast read on whether a vacancy is worth your time.**

A Chrome extension that scores how well you fit an [hh.ru](https://hh.ru) vacancy while you browse it normally. It reads the posting, compares it against your profile, and shows a colour-coded fit gauge, a requirement-by-requirement checklist built from that specific vacancy, and any red flags — in about a second.

You still apply manually. Litmus only helps you decide faster and better.

---

## What it shows

Injected at the top of any hh.ru vacancy page:

```
  ╭──────────╮   Skills match      ███████░░░  72%
  │   78%    │   Requirements      ████████░░  81%
  │   FIT    │   Experience level  ██████████  100%
  ╰──────────╯   Role / domain     ███████░░░  75%
                 Location / format █████░░░░░  50%

  REQUIREMENTS (9)
  ✕  Опыт коммерческой разработки на Go от 3 лет         12%
  !  Знание Kubernetes                                    55%
  ✓  Python, PyTorch, опыт обучения моделей               94%

  RED FLAGS
  !  Unpaid test task                                     83%
```

Plus buttons to copy the vacancy as clean plain text, or copy it bundled with your profile and a ready cover-letter prompt for an LLM.

## Why it exists

hh.ru closed its public API for job seekers in December 2025, and `GET /vacancies` has returned 403 for unauthorised requests since April 2026. Scraping and auto-apply tools violate hh's rules and get accounts banned.

Litmus sidesteps both problems by only ever processing the page you already have open, as a normal logged-in user. It does no background fetching, no crawling, and never clicks "Откликнуться" for you.

## How it works

```
page load → detect.js  confirms it's a vacancy page (and watches SPA navigation)
          → extract.js builds a structured vacancy object
          → background.js  cache check → one Jev API call
          → scoring.js  weights, thresholds, dealbreakers → final score
          → panel.js  renders the gauge in a Shadow DOM
```

Scoring runs on [Jev](https://docs.typesafe.ai) (TypeSafe AI), a "System One" model that returns **typed decisions with calibrated probabilities rather than text** — so it cannot hallucinate outside the defined options. Every question for a vacancy goes in a single batched call; the overall percentage is then computed in code, never asked of the model.

### The interesting part: building the requirement checklist

Jev returns typed decisions, never free text, so it cannot hand back "here are the 9 requirements." That list has to be built client-side — and whatever the code builds is what the user sees.

The obvious approach is to treat the `<li>` items in the description as the requirements. Measured against three real vacancy pages, that fails on two of them:

| Page | `<li>` found | What they actually are |
|---|---|---|
| AI Automation Engineer | **0** | 72 `<p>`, no lists at all — checklist renders empty |
| CV Engineer | 14 | Genuine requirements ✅ |
| Junior web analyst | 16 | Company perks — "Создаем комьюнити", "Заботимся о людях" |

On the third page it would confidently score you against the employer's own marketing copy. Worse than empty, because it looks like it's working.

Matching on section headers (`Требования:`, `Requirements:`) fails too — one of the three pages words it *"Для успешного старта карьеры тебе нужно:"*, which no keyword list anticipates, and every miss is silent.

So Litmus doesn't try to identify requirements structurally. It **harvests generously, then lets the model discard**:

1. Take every leaf `<li>` *and* every leaf `<p>` in the description — no keywords, no structural or language assumptions.
2. Ask two atomic yes/no questions per line, in the same batched call: *is this a requirement?* and *does the candidate satisfy it?*
3. Keep a line only if the first probability clears a threshold, then render the second as ✓ / ! / ✕.

This works on all three page shapes, in any language, for any profession. It costs about $0.0006 per vacancy.

## Install

Not on the Chrome Web Store — load it unpacked:

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the repo folder.
4. The setup page opens automatically.

Works on any Chromium browser: Chrome, Edge, Yandex, Opera.

## Setup

1. **API key** — get one from [TypeSafe AI](https://docs.typesafe.ai). Paste it in and hit *Test connection*. Stored only in `chrome.storage.local`.
2. **Profile** — desired role, skills, experience, projects, education. There's a "paste your resume" fallback for a quick start. Scoring stays disabled until this is filled, because an empty profile produces confident nonsense rather than an obvious error.
3. **Preferences** — work format, relocation, minimum salary, employment type, target level. These drive the dealbreaker checks that cap the score.

## Cost

Jev charges $0.042 per million input tokens; output is free. Measured on real pages:

| Vacancy size | Questions | Tokens | Cost |
|---|---|---|---|
| Large (60 requirement candidates) | 136 | ~14.8k | $0.00062 |
| Medium (23) | 61 | ~8.6k | $0.00036 |
| Small (15) | 46 | ~4.9k | $0.00020 |

Roughly 8,000 vacancies on TypeSafe's $5 free credit. Results are cached by vacancy ID, so revisiting a posting costs nothing.

## Privacy and boundaries

These are deliberate constraints, not omissions:

- Only processes pages you open yourself. No background fetching, no crawling.
- No auto-applying and no auto-clicking "Откликнуться" — hh bans accounts for automation.
- Your API key and profile live in `chrome.storage.local` and are sent nowhere except the scoring call to `api.typesafe.ai`.
- Permissions are limited to `*.hh.ru` and `api.typesafe.ai`. No remote code loading.
- Profile export deliberately excludes the API key.

## Development

```bash
npm install
npm test      # extractor vs. the saved test corpus
npm run dry   # extract → questions → mocked Jev → scoring, end to end, no key needed
```

`npm run dry` needs no API key and makes no network calls, so it's the fastest way to see the whole pipeline and check token budgets after a change.

The extractor is validated against three deliberately dissimilar saved vacancy pages. **Those pages are not in this repo** — they're saves of an authenticated session and contain personal session artifacts. To rebuild the corpus, open a few hh.ru vacancies and save each with Ctrl+S → "Webpage, complete" into `toBeIgnored/`.

[`SPEC.md`](SPEC.md) holds the full design document: verified page facts, locked decisions and the reasoning behind them, and the open risks.

### Layout

```
manifest.json      MV3 manifest
background.js      service worker: Jev calls, retry/backoff, cache, usage counter
content/
  detect.js        vacancy-URL check + SPA navigation watcher
  extract.js       JSON-LD + data-qa merge, requirement harvesting
  panel.js         the injected gauge panel (Shadow DOM)
lib/
  jev.js           API client
  questions.js     builds the question set
  scoring.js       weights, thresholds, dealbreakers → final score
  defaults.js      storage schema and defaults
options/           onboarding wizard, profile, preferences, settings
popup/             status and usage counter
tools/             test harnesses
```

## Status

v0.1.0 — working prototype. The v2 plans (application tracker, skill-gap analysis across viewed vacancies, fit badges on search results) are sketched in `SPEC.md`.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with hh.ru or TypeSafe AI.
