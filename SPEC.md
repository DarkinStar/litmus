Project: Litmus — hh.ru vacancy fit scorer, a Chrome extension powered by Jev

This is the internal design document. README.md is the public-facing one.
Repo: https://github.com/DarkinStar/litmus  (MIT, public)

=============================================================
0. STATUS & DECISION LOG  (read this first)
=============================================================
Last updated: 2026-09-22

Phase: research DONE. v1 PROTOTYPE BUILT (v0.1.0), not yet run against the
live API. Every file in §8 exists. Both harnesses pass:
    npm test   extract.js vs the 3 saved pages (§9 regression rule)
    npm run dry  extract -> questions -> mocked Jev -> scoring, end to end
UNVERIFIED until the first real call: the Jev request/response shape (taken
from docs.typesafe.ai/api.md, not yet exercised) and the latency risk in §5.2.

Section 8 of the old spec ("needed before building") is now satisfied. Three
real hh.ru vacancy pages were saved and inspected. The findings are in §4
below and they CHANGED the design — do not re-derive them, do not re-litigate
them.

Decisions locked (do not reopen without a reason):
  D1. Extraction = JSON-LD MERGED WITH data-qa. Neither alone is enough. (§4.1)
  D2. HH-Lux-InitialState SSR blob is NOT usable. Ruled out, tested. (§4.2)
  D3. Requirement checklist is NOT built from <li>. That approach fails on
      2 of 3 real pages. Replaced by harvest-then-let-Jev-filter. (§5.2)
  D4. Never parse human-readable label text. The UI renders in ENGLISH on
      this account. Key off data-qa markers + digit regexes only. (§4.4)
  D5. Send Jev the extracted FIELDS, never raw page HTML. (§5.1)
  D6. Fit result is shown as a VISUAL gauge, not a bare number. (§6.4)
  D7. The profile is mandatory; scoring stays disabled until it is filled.

Defaults chosen on the user's behalf (flag if you disagree):
  - Requirement filter threshold: keep a line if is_requirement >= 0.60,
    exposed as a setting.
  - Lines with low is_requirement but high satisfies: hidden from the
    checklist; visible only behind a "show discarded lines" debug toggle.
  - Checklist contributes a PASS-RATE (not a pass-count) to the overall
    score, because the surviving requirement count varies per vacancy
    (measured: 9 vs 14 vs 3).

=============================================================
1. Goal
=============================================================
A personal Chrome extension (Chromium: Chrome, Edge, Yandex, Opera) that,
while I browse hh.ru normally, detects vacancy pages, sends the vacancy +
my profile to the Jev model, and shows in under 1 second:

  - an overall fit percentage, drawn as a visual gauge
  - sub-category scores
  - a requirement-by-requirement checklist built from that specific vacancy
  - red flags
  - buttons to copy the vacancy text and copy a ready-made AI prompt for a
    cover letter

I still apply manually. The extension only helps me decide faster and better.

Scope: built for my own use, but designed to be universal (works for any
profession and profile, nothing hardcoded to me). No monetization, no backend
server, no store publishing for now. Bring-your-own API key.

=============================================================
2. Rules / boundaries (non-negotiable)
=============================================================
Only process pages I open myself. No background fetching, no crawling.
On search result pages (v2), score only snippets already visible on screen.
No auto-applying, no auto-clicking "Откликнуться". hh bans accounts for that.
API key stored only in chrome.storage.local. Never hardcoded, never committed.
Minimal permissions: *.hh.ru and api.typesafe.ai only. No remote code loading.
Cache results by vacancy ID so revisits don't re-call the API.

Why this design: hh.ru closed its public API for job seekers (Dec 15, 2025),
and GET /vacancies returns 403 for unauthorized requests since April 2026.
Scraping and auto-apply tools violate hh's rules and risk the account.
Processing only the pages I view as a normal user avoids both problems.

=============================================================
3. The model: Jev (TypeSafe AI)
=============================================================
"System One" model: not an LLM. Returns typed decisions with calibrated
probabilities, not text, so it cannot hallucinate outside the defined options.

Endpoint: POST https://api.typesafe.ai/v1/systemone
Headers:  Authorization: Bearer <KEY>, Content-Type: application/json
Body:     { "state": <string | JSON object | array of text>,
            "model": "jev-latest",
            "questions": { <key>: { type, instructions, criteria } } }

EXACT request shape, from https://docs.typesafe.ai/api.md — every question is
an OBJECT with `type` + `instructions` + `criteria`. Note that noul takes a
criteria dict too; it is not a bare string:

  "is_urgent":   { "type": "noul",
                   "instructions": "Does this convey urgency?",
                   "criteria": { "true": "Explicitly time-sensitive",
                                 "false": "No urgency expressed" } }

  "department":  { "type": "choice",
                   "instructions": "Which team should handle this?",
                   "criteria": { "billing": "Payments, invoicing, refunds",
                                 "technical": "Bugs, outages, integrations" } }

  "frustration": { "type": "score",
                   "instructions": "How frustrated is the customer?",
                   "criteria": ["Calm", "Frustrated", "Very angry"] }

Answer fields by type:
  noul   -> "noul" (0-1)
  choice -> "choice", "probabilities", "confidence"  (max 255 options)
  score  -> "score" (level index), "legend", "probabilities", "confidence"

Probability vs confidence: probability = which answer it leans to;
confidence = how much to trust the judgment. Use probability for decisions,
confidence to flag "check manually".

All questions are evaluated in parallel and independently in one call.
Adding questions barely adds latency. Fixed overhead ~390 tokens per call,
so batch ALL questions for a vacancy into ONE call.

Price: $0.042 per million input tokens; output free.
Free credit: $5, expires Oct 21, 2026.
Limits: text only; 64k tokens per request (32k for state + longest single
question). Rate limits dynamic -> handle 429 with retry + backoff
(respect retry-after).
Language: English is strongest. Write questions in English; keep vacancy text
in Russian as-is. (Tested: works well.)
Latency measured from Yekaterinburg: ~0.7s end-to-end.
Docs: https://docs.typesafe.ai  (index: https://docs.typesafe.ai/llms.txt)
JS SDK exists (@typesafe-ai/sdk), but plain fetch is simpler in an extension.

Sample response shape:
{
  "model": "jev-1.13.0",
  "answers": {
    "q1": { "type": "noul", "noul": 0.98 },
    "q2": { "type": "choice", "choice": "backend", "confidence": 0.85,
            "probabilities": { "backend": 0.9, "other": 0.1, "ml": 0.0 } }
  },
  "usage": { "input_tokens": 394, "output_tokens": 56 }
}

=============================================================
4. VERIFIED PAGE FACTS  (measured, do not re-derive)
=============================================================
Test corpus, saved with Ctrl+S "Webpage, complete", kept in toBeIgnored/:
  A. "AI Automation Engineer / AI-оркестратор"  id 137637713  Moscow
  B. "Инженер компьютерного зрения"             id 137571614  Yekaterinburg
  C. "Младший веб-аналитик"                     id 137510416  Nizhny Novgorod
These 3 are deliberately structurally different. Any extractor change MUST be
re-tested against all three before being considered working.

--- 4.1  JSON-LD is necessary but NOT sufficient ---------------------------
<script type="application/ld+json"> with @type JobPosting: present on 3/3.
  Provides: title, description (HTML string), datePosted, validThrough,
            hiringOrganization.name, jobLocation.address.*,
            identifier.value  <- the vacancy ID
  MISSING:  baseSalary, experienceRequirements, employmentType, skills.
So salary/experience/format/skills MUST come from data-qa. Merge both sources.

--- 4.2  The SSR state blob is a dead end ----------------------------------
<template id="HH-Lux-InitialState"> exists and would have been ideal (it
holds the full vacancy object server-side). Lux EMPTIES it after hydration.
Measured length: 0 on 3/3. Ruled out. Do not spend time on it again.

--- 4.3  data-qa selectors, verified ---------------------------------------
  vacancy-title                          3/3
  vacancy-company-name                   3/3
  vacancy-description                    3/3
  vacancy-experience                     3/3
  work-formats-text                      3/3
  common-employment-text                 3/3
  work-experience-text                   3/3
  vacancy-salary                         2/3  (absent = salary not posted)
  vacancy-salary-compensation-type-net   |  locale-INDEPENDENT tax marker
  vacancy-salary-compensation-type-gross |  use this, not the words
  skills-element                         2/3  (key-skill tags, bonus signal)
  vacancy-address-with-map               3/3
Never use CSS classes; they change constantly.
Beware: vacancy-serp__* attributes also appear on a vacancy page (the
"similar vacancies" block at the bottom). Our exact names don't collide, but
scope queries to the main vacancy container to stay safe.
Missing field -> null, never crash.

--- 4.4  The page renders in ENGLISH ---------------------------------------
Observed literal values on this account:
  vacancy-salary         "from 100 000 ₽ per month, after taxes"
  vacancy-experience     "1-3 years"  /  "not required"
  work-formats-text      "Work format: remotely"
  common-employment-text "Full-time employment"
Therefore: NEVER match on Russian (or English) label text. Parse numbers with
a digit regex, take tax status from the data-qa marker, and keep the raw
string as a passthrough field for Jev to read.

--- 4.5  Description structure is wildly inconsistent ----------------------
  A: 72 <p>, ZERO <ul>. Requirements are plain paragraphs under a
     <strong>Требования</strong> line.
  B: clean <strong>Обязанности:</strong> + <ul>. The ideal case.
  C: 3 <ul> present, but they hold COMPANY PERKS ("Создаем комьюнити",
     "Заботимся о людях"), not requirements. The real requirements sit under
     "Для успешного старта карьеры в E-Promo тебе нужно:".
This is why D3 exists. See §5.2.

=============================================================
5. Scoring design
=============================================================
--- 5.1  What gets sent ----------------------------------------------------
state = {
  "vacancy":     { ...extracted fields from §4, description as plain text... },
  "candidate":   { ...profile from the options page... },
  "preferences": { ...work format, relocation, min salary, level... }
}
Extracted FIELDS only. Never raw page HTML — it would blow past the 32k state
limit and bury the signal in nav chrome and tracker scripts.
Measured size: ~2.6k tokens for the heaviest of the 3 test pages.

ONE API call per vacancy, containing: sub-category questions + requirement
questions + red-flag questions + dealbreaker questions.

--- 5.2  Requirement decomposition (D3) ------------------------------------
Jev returns typed decisions, never free text, so it CANNOT hand back "here
are the 9 requirements". The list must be built client-side. The old <li>
rule fails on 2 of 3 pages (§4.5). Replacement, in three steps:

  Step 1 HARVEST (code, generous, no keywords):
    every leaf <li> AND every leaf <p> inside vacancy-description,
    trimmed, deduped, keep length 15..300 chars.
    Measured candidate counts: A=65, B=15, C=23. Cap at 60.
    No language assumptions, no structural assumptions, no keyword lists.

  Step 2 ASK two ATOMIC noul questions per candidate, in the same one call:
    req_N_is  : "This text states a requirement or expectation placed on
                 the candidate: '<line>'"
    req_N_fit : "The candidate's profile satisfies this requirement: '<line>'"

  Step 3 FILTER in code:
    keep the line only if req_N_is >= 0.60 (configurable),
    then render req_N_fit as the check state.

Why not a keyword/header heuristic: it needs a bilingual keyword list that
must be maintained forever, and every miss is SILENT. Page C's header
("тебе нужно") is a real requirements header no keyword list would catch.
Same failure mode as CSS classes, one level up.

Why two nouls and not one 4-way choice: a choice entangles two different
judgments — a requirement the candidate plainly fails splits probability
between not_a_requirement and not_satisfied, and you can't tell which
happened. Two nouls keep each judgment atomic (see §5.4). The choice variant
saves tokens we are not spending anyway.

Cost of this approach, MEASURED by `npm run dry` against the real corpus
(these supersede an earlier hand estimate that forgot each question also
carries its own `criteria` true/false descriptions — roughly 2x higher):
  page A  60 candidates (capped) -> 136 questions -> ~14.8k tok -> $0.00062
  page B  15 candidates          ->  46 questions ->  ~4.9k tok -> $0.00020
  page C  23 candidates          ->  61 questions ->  ~8.6k tok -> $0.00036
Worst case is under a tenth of a cent; the $5 credit is ~8,000 vacancies at
page-A size. The heaviest page uses 23% of the 64k request limit and 6% of
the 32k state limit. Cost is NOT a constraint, which is why harvesting is
deliberately generous rather than cleverly pre-filtered — a tight filter
risks dropping a real requirement to save money we aren't spending.

OPEN RISK — latency. The <1s target depends on the documented claim that
questions run in parallel and "adding questions barely adds latency". 130
questions is a much harder test of that than the 2-question sample. MEASURE
on the first real call. If it busts the budget, cap candidates to ~40 by
dropping the longest ones (long prose paragraphs are rarely one requirement).

--- 5.3  Overall score (computed in code, not by the model) ----------------
fit = sum(weight_i * subscore_i), with the requirement PASS-RATE blended in.
Default weights (editable):
  skills 0.30, requirements checklist 0.25, experience level 0.20,
  role/domain 0.15, location/format 0.10
Dealbreaker triggered (>0.7) -> cap overall at ~30% and show the reason.
Salary: vacancy salary present and below my minimum -> dealbreaker.
        Salary absent -> neutral, never penalised.
Log the model version from each response (aliases change behavior on update).

--- 5.4  Question discipline -----------------------------------------------
Keep every question atomic: one narrow judgment each. Combine in code.

=============================================================
6. Features — MVP (v1)
=============================================================
--- 6.1  Onboarding (first launch opens the options page automatically) -----
Step 1: API key + "Test connection" button (one tiny Jev call -> OK or a
        clear error message).
Step 2: Profile, a structured form modeled on an hh resume:
        desired position(s); work experience entries (company, role, dates,
        description); education; skills (tag input); projects (name,
        description, achievements, tech); languages + level; city.
        Fallback: a "paste your resume text" big text box for a quick start.
Step 3: Preferences (what I want, separate from who I am):
        work format remote/office/hybrid; relocation yes/no; minimum salary;
        employment type (full/part/project/internship); target level
        (intern/junior/middle/senior).
The profile is REQUIRED (D7) — scoring stays disabled until it is filled,
because an empty profile silently produces meaningless fit scores.

--- 6.2  Auto-detection ----------------------------------------------------
Content script matches https://*.hh.ru/vacancy/* (covers regional subdomains
like ekaterinburg.hh.ru). Runs on page load AND handles hh's in-page SPA
navigation when the URL changes without a reload.

--- 6.3  Data extraction ---------------------------------------------------
Per §4. JSON-LD merged with data-qa, requirement candidates per §5.2,
vacancy ID from JSON-LD identifier.value (URL is the fallback) and used as
the cache key.

--- 6.4  Score panel (injected at top of the vacancy page, collapsible) ----
Rendered in a Shadow DOM so hh's CSS cannot leak in.
VISUAL first (D6): the overall fit is a circular gauge ring — the number is
drawn inside the ring, the ring fills proportionally and is colour-coded:
  green >= 75, yellow 50-74, red < 50  (thresholds adjustable)
Below the gauge:
  - sub-category bars, each a labelled horizontal bar: skills match,
    experience level fit, location / work format, salary vs my minimum,
    domain / role match
  - the requirement checklist:
        OK    >= 70%
        WARN  40-69%, or low confidence ("unsure")
        FAIL  < 40%
  - red flags (one noul each, shown only when triggered): unpaid test task;
    "gray"/unofficial salary; vague or empty description; recruiting agency
    rather than direct employer; "internship" that is really unpaid work;
    requirements unrealistically inflated for the stated level
  - dealbreakers from preferences (format, relocation, salary, level): if any
    triggers with high probability, the overall score is capped and a clear
    warning is shown
Low-confidence answers get a "check manually" marker.
Loading state while waiting; clear error message on failure (bad key, 429,
network).

--- 6.5  Buttons -----------------------------------------------------------
Copy vacancy: clean plain text (title, company, salary, experience,
              requirements, description) without hh clutter.
Copy for AI:  vacancy text + my profile + a ready prompt ("Write a tailored
              cover letter for this vacancy based on my profile...") to paste
              into Claude/ChatGPT.
Re-score:     ignore cache and call again (e.g. after editing the profile).

--- 6.6  Settings & data ---------------------------------------------------
Adjustable weights for sub-categories (sane defaults so it works untouched).
Adjustable colour thresholds.
Requirement filter threshold (§5.2 step 3).
"Show discarded lines" debug toggle.
Export / import profile + settings as JSON (backup, move between PCs).
Usage counter: calls made, tokens used, estimated credit spent.
Clear cache button.

=============================================================
7. Features — later
=============================================================
v2: application tracker (Interested / Applied / Interview / Rejected / Offer),
    popup lists all with score, date, link, export CSV.
    Skill gap analysis: aggregate failed requirements across viewed vacancies,
    e.g. "Docker missing in 14 of 30 vacancies you viewed".
    Search-result badges: small fit % badge on each visible card.
    Company blacklist: hide or flag chosen companies.
v3: multiple profiles (e.g. ML vs Backend), switchable. RU/EN interface.
    Site adapter pattern -> Habr Career, SuperJob.

=============================================================
8. Architecture (Manifest V3)
=============================================================
litmus/
├── manifest.json        version, permissions, host_permissions
│                        (*.hh.ru, api.typesafe.ai)
├── background.js        service worker: calls Jev (avoids CORS), retries,
│                        cache, usage counter
├── content/
│   ├── detect.js        URL check + SPA navigation watcher
│   ├── extract.js       JSON-LD + data-qa merge, requirement harvest
│   └── panel.js         inject gauge panel, checklist, buttons (Shadow DOM)
├── lib/
│   ├── questions.js     builds the question set from vacancy + profile + prefs
│   └── scoring.js       weights, thresholds, dealbreakers -> final score
├── options/             onboarding wizard + profile + preferences + settings
│   ├── options.html
│   ├── options.js
│   └── options.css
└── popup/               quick status, usage counter, (v2) tracker
    ├── popup.html
    └── popup.js

Flow: page load -> detect.js confirms vacancy page -> extract.js builds the
vacancy object -> message to background.js -> cache check -> Jev call ->
scoring.js -> result to panel.js -> render gauge.

=============================================================
9. Development & updates (personal use)
=============================================================
Code on GitHub (private or public; NEVER commit the API key).
toBeIgnored/ holds the saved test pages — add it to .gitignore (~3 MB of
saved HTML, useful locally, not worth committing).
Install: chrome://extensions -> Developer mode -> Load unpacked -> the folder.
Update: git pull -> click reload on the extension card. Profile, settings and
key persist (stored in the browser, not the folder).
Bump "version" in manifest.json with each change.
Keep the code store-compatible (no remote code, minimal permissions) in case
I publish later.

REGRESSION RULE: extract.js must be re-tested against all three pages in
toBeIgnored/ after any change. A jsdom harness is the fastest way (they are
plain saved HTML). If it doesn't produce sane output on all 3, it's broken.

=============================================================
10. My working preference
=============================================================
I prefer each step handled in one comprehensive response (full files, not
fragments) rather than many back-and-forth turns.
