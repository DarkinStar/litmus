// Turns Jev's flat answer map into the final result object. §5.3.
// The overall score is computed HERE, in code, never asked of the model.

import { FLAG_QUESTIONS, DEALBREAKER_QUESTIONS, SHOWN_KINDS } from './questions.js';

/** A `score` answer is a level index; map it onto 0..100 across the scale. */
function levelToPct(answer, levelCount) {
  if (!answer || typeof answer.score !== 'number') return null;
  if (levelCount <= 1) return null;
  const idx = Math.max(0, Math.min(levelCount - 1, answer.score));
  return Math.round((idx / (levelCount - 1)) * 100);
}

const prob = (a) => (a && typeof a.noul === 'number' ? a.noul : null);

/**
 * Collapse a satisfaction `choice` into one continuous 0..1 fit.
 * The not_addressed mass is removed from the denominator rather than counted
 * as failure: "your profile never mentions Linux" is not "you don't know Linux".
 * Returns null when the answer is dominated by not_addressed — that item is
 * unassessable and is kept out of the pass rate entirely.
 */
function fitFromChoice(a) {
  if (!a || typeof a.choice !== 'string') return { fit: null, choice: null, confidence: null };
  const p = a.probabilities || {};
  const sat = p.satisfied ?? 0;
  const part = p.partial ?? 0;
  const not = p.not_satisfied ?? 0;
  const mass = sat + part + not;

  // The model's own pick wins for display; the probabilities give granularity.
  const unassessable = a.choice === 'not_addressed' || mass <= 0.001;
  return {
    fit: unassessable ? null : (sat + 0.5 * part) / mass,
    choice: a.choice,
    confidence: typeof a.confidence === 'number' ? a.confidence : null
  };
}

export function computeResult({ answers, reqIndex, askedSubs, settings, vacancy, modelVersion, usage, latencyMs }) {
  // ---- sub-category scores -------------------------------------------------
  const subs = {};
  for (const key of askedSubs) {
    const a = answers[`sub_${key}`];
    const pct = levelToPct(a, 5);
    if (pct === null) continue;
    subs[key] = {
      pct,
      confidence: typeof a.confidence === 'number' ? a.confidence : null,
      unsure: typeof a.confidence === 'number' && a.confidence < settings.lowConfidence
    };
  }

  // ---- requirement checklist (§5.2 step 3) ---------------------------------
  // Lines are grouped by the classifier's `kind`, not filtered by a threshold.
  const groups = { hard_requirement: [], nice_to_have: [], eligibility: [] };
  const discarded = [];

  for (const [base, text] of Object.entries(reqIndex)) {
    const kindAnswer = answers[`${base}_kind`];
    const kind = kindAnswer && typeof kindAnswer.choice === 'string' ? kindAnswer.choice : null;
    if (!kind) continue;

    const { fit, choice, confidence } = fitFromChoice(answers[`${base}_fit`]);
    const entry = {
      text,
      kind,
      kindConfidence: typeof kindAnswer.confidence === 'number' ? kindAnswer.confidence : null,
      fit,                                   // null when unassessable
      fitChoice: choice,
      confidence,
      unassessed: fit === null,
      state: fit === null ? 'unknown' : fitState(fit, settings),
      unsure: typeof confidence === 'number' && confidence < settings.lowConfidence
    };

    if (SHOWN_KINDS.includes(kind)) groups[kind].push(entry);
    else discarded.push(entry);
  }

  // Worst fit first — the gaps are the reason you are reading this list.
  // Unassessable items sink to the bottom; they are prompts, not verdicts.
  const byFit = (a, b) => {
    if (a.unassessed !== b.unassessed) return a.unassessed ? 1 : -1;
    return (a.fit ?? 0) - (b.fit ?? 0);
  };
  for (const k of SHOWN_KINDS) groups[k].sort(byFit);

  // §0 — pass RATE, not count. Hard requirements only: an optional "будет
  // плюсом" must not weigh the same as a must-have. Unassessable items are
  // excluded from both numerator and denominator.
  const rated = [
    ...groups.hard_requirement,
    ...(settings.scoreNiceToHave ? groups.nice_to_have : [])
  ].filter((r) => !r.unassessed);

  const passRate = rated.length
    ? rated.reduce((sum, r) => sum + r.fit, 0) / rated.length
    : null;

  const unassessedCount = SHOWN_KINDS
    .reduce((n, k) => n + groups[k].filter((r) => r.unassessed).length, 0);

  // Eligibility lines are pass/fail gates, not scored skills. A clearly failed
  // one (student status, hours per week) matters more than any percentage.
  const eligibilityFailures = groups.eligibility
    .filter((r) => !r.unassessed && r.fit < settings.reqFail);

  const requirements = groups.hard_requirement;

  // ---- weighted overall ----------------------------------------------------
  const parts = [];
  const w = settings.weights;
  if (subs.skills) parts.push([w.skills, subs.skills.pct]);
  if (passRate !== null) parts.push([w.requirements, Math.round(passRate * 100)]);
  if (subs.experience) parts.push([w.experience, subs.experience.pct]);
  if (subs.domain) parts.push([w.domain, subs.domain.pct]);
  if (subs.location) parts.push([w.location, subs.location.pct]);

  // Renormalise so a missing component (no salary, no requirements found)
  // never silently drags the score down.
  const totalWeight = parts.reduce((s, [wt]) => s + wt, 0);
  let overall = totalWeight > 0
    ? Math.round(parts.reduce((s, [wt, v]) => s + wt * v, 0) / totalWeight)
    : null;

  // ---- red flags -----------------------------------------------------------
  const flags = [];
  for (const [key, def] of Object.entries(FLAG_QUESTIONS)) {
    const p = prob(answers[`flag_${key}`]);
    if (p !== null && p >= 0.5) flags.push({ key, label: def.label, prob: p });
  }
  flags.sort((a, b) => b.prob - a.prob);

  // ---- dealbreakers cap the score (§5.3) -----------------------------------
  const dealbreakers = [];
  for (const [key, def] of Object.entries(DEALBREAKER_QUESTIONS)) {
    const p = prob(answers[`db_${key}`]);
    if (p !== null && p >= settings.dealbreakerProb) {
      dealbreakers.push({ key, label: def.label, prob: p });
    }
  }
  dealbreakers.sort((a, b) => b.prob - a.prob);

  let capped = false;
  if (dealbreakers.length && overall !== null && overall > settings.dealbreakerCap) {
    overall = settings.dealbreakerCap;
    capped = true;
  }

  return {
    overall,
    band: band(overall, settings),
    subs,
    requirements,                 // hard requirements (the main checklist)
    niceToHave: groups.nice_to_have,
    eligibility: groups.eligibility,
    eligibilityFailures,
    discarded,                    // headings, duties, benefits — kinds not shown
    passRate,
    ratedCount: rated.length,
    unassessedCount,
    flags,
    dealbreakers,
    capped,
    vacancy: {
      id: vacancy.id,
      title: vacancy.title,
      company: vacancy.company,
      url: vacancy.url
    },
    meta: {
      modelVersion,                       // §5.3 — aliases change behaviour on update
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      latencyMs: latencyMs ?? null,
      questionCount: Object.keys(answers).length,
      scoredAt: Date.now()
    }
  };
}

export function fitState(fit, settings) {
  if (fit >= settings.reqOk) return 'ok';
  if (fit >= settings.reqFail) return 'warn';
  return 'fail';
}

export function band(overall, settings) {
  if (overall === null) return 'unknown';
  if (overall >= settings.thresholds.green) return 'green';
  if (overall >= settings.thresholds.yellow) return 'yellow';
  return 'red';
}
