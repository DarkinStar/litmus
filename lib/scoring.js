// Turns Jev's flat answer map into the final result object. §5.3.
// The overall score is computed HERE, in code, never asked of the model.

import {
  FLAG_QUESTIONS, DEALBREAKER_QUESTIONS, SHOWN_KINDS, SCORABLE_KINDS
} from './questions.js';

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
 * Returns fit === null when the item is unassessable; those are excluded from
 * the pass rate and counted as missing coverage instead.
 */
function fitFromChoice(a) {
  if (!a || typeof a.choice !== 'string') return { fit: null, choice: null, confidence: null };
  const p = a.probabilities || {};
  const sat = p.satisfied ?? 0;
  const part = p.partial ?? 0;
  const not = p.not_satisfied ?? 0;
  const mass = sat + part + not;

  const unassessable = a.choice === 'not_addressed' || mass <= 0.001;
  return {
    fit: unassessable ? null : (sat + 0.5 * part) / mass,
    choice: a.choice,
    confidence: typeof a.confidence === 'number' ? a.confidence : null
  };
}

export function computeResult({
  answers, reqIndex, askedSubs, computedSubs, settings, vacancy,
  modelVersion, usage, latencyMs
}) {
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
  // Deterministic sub-scores from hh's closed vocabulary. Never uncertain.
  for (const [key, c] of Object.entries(computedSubs || {})) {
    subs[key] = { pct: c.pct, confidence: 1, unsure: false, computed: true, reason: c.reason };
  }

  // Shown beside the gauge, never folded into it: "have you done this work?"
  // is a different question from "do you clear their stated bar?".
  const taskAffinity = levelToPct(answers.task_affinity, 5);

  // ---- requirement checklist (§5.2 step 3) ---------------------------------
  const groups = { hard_requirement: [], nice_to_have: [], eligibility: [], soft_skill: [] };
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
      fit,
      fitChoice: choice,
      confidence,
      unassessed: fit === null,
      state: fit === null ? 'unknown' : fitState(fit, settings),
      unsure: typeof confidence === 'number' && confidence < settings.lowConfidence
    };

    if (SHOWN_KINDS.includes(kind)) groups[kind].push(entry);
    else discarded.push(entry);
  }

  const byFit = (a, b) => {
    if (a.unassessed !== b.unassessed) return a.unassessed ? 1 : -1;
    return (a.fit ?? 0) - (b.fit ?? 0);
  };
  for (const k of SHOWN_KINDS) groups[k].sort(byFit);

  // ---- pass rate, coverage, bonus ------------------------------------------
  // Hard requirements only. An optional "будет плюсом" must not weigh the same
  // as a must-have, and a soft skill cannot be judged from a CV at all.
  const hard = groups.hard_requirement;
  const rated = hard.filter((r) => !r.unassessed);
  const rawPassRate = rated.length
    ? rated.reduce((sum, r) => sum + r.fit, 0) / rated.length
    : null;

  // Excluding unassessable items stopped punishing a silent profile, but
  // created the mirror problem: a thinner profile had fewer items assessed and
  // so scored HIGHER. Coverage makes that visible and damps the requirement
  // component, floored so it degrades gracefully instead of collapsing.
  const coverage = hard.length ? rated.length / hard.length : null;
  const coverageFactor = coverage === null
    ? 1
    : settings.coverageFloor + (1 - settings.coverageFloor) * coverage;

  const passRate = rawPassRate === null ? null : rawPassRate * coverageFactor;

  // Nice-to-haves are upside only: they can add, never subtract.
  const niceRated = groups.nice_to_have.filter((r) => !r.unassessed);
  const niceRate = niceRated.length
    ? niceRated.reduce((s, r) => s + r.fit, 0) / niceRated.length
    : null;
  const niceBonus = niceRate === null ? 0 : Math.round(niceRate * settings.niceToHaveBonus);

  const unassessedByKind = {};
  for (const k of SHOWN_KINDS) unassessedByKind[k] = groups[k].filter((r) => r.unassessed).length;
  const unassessedCount = unassessedByKind.hard_requirement;

  // Eligibility lines are pass/fail gates, not scored skills.
  const eligibilityFailures = groups.eligibility
    .filter((r) => !r.unassessed && r.fit < settings.reqFail);

  // ---- weighted overall ----------------------------------------------------
  const parts = [];
  const w = settings.weights;
  if (passRate !== null) parts.push([w.requirements, Math.round(passRate * 100)]);
  if (subs.experience) parts.push([w.experience, subs.experience.pct]);
  if (subs.domain) parts.push([w.domain, subs.domain.pct]);
  if (subs.location) parts.push([w.location, subs.location.pct]);

  const totalWeight = parts.reduce((s, [wt]) => s + wt, 0);
  let overall = totalWeight > 0
    ? Math.round(parts.reduce((s, [wt, v]) => s + wt * v, 0) / totalWeight)
    : null;

  if (overall !== null && niceBonus) overall = Math.min(100, overall + niceBonus);

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
    taskAffinity,
    requirements: hard,
    niceToHave: groups.nice_to_have,
    eligibility: groups.eligibility,
    softSkills: groups.soft_skill,
    eligibilityFailures,
    discarded,
    passRate,
    rawPassRate,
    coverage,
    ratedCount: rated.length,
    hardCount: hard.length,
    unassessedCount,
    unassessedByKind,
    niceBonus,
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
      modelVersion,
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

export { SCORABLE_KINDS };
