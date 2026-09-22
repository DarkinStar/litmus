// Turns Jev's flat answer map into the final result object. §5.3.
// The overall score is computed HERE, in code, never asked of the model.

import { FLAG_QUESTIONS, DEALBREAKER_QUESTIONS } from './questions.js';

/** A `score` answer is a level index; map it onto 0..100 across the scale. */
function levelToPct(answer, levelCount) {
  if (!answer || typeof answer.score !== 'number') return null;
  if (levelCount <= 1) return null;
  const idx = Math.max(0, Math.min(levelCount - 1, answer.score));
  return Math.round((idx / (levelCount - 1)) * 100);
}

const prob = (a) => (a && typeof a.noul === 'number' ? a.noul : null);

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
  const requirements = [];
  const discarded = [];
  for (const [base, text] of Object.entries(reqIndex)) {
    const isReq = prob(answers[`${base}_is`]);
    const fit = prob(answers[`${base}_fit`]);
    if (isReq === null || fit === null) continue;

    const entry = { text, isReq, fit, state: fitState(fit, settings) };
    if (isReq >= settings.reqThreshold) requirements.push(entry);
    else discarded.push(entry);
  }
  // Worst fit first — the gaps are the reason you are reading this list.
  requirements.sort((a, b) => a.fit - b.fit);

  // §0 default — pass RATE, not count, because the surviving count varies a lot.
  const passRate = requirements.length
    ? requirements.reduce((sum, r) => sum + r.fit, 0) / requirements.length
    : null;

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
    requirements,
    discarded,
    passRate,
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
