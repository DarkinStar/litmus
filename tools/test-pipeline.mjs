// End-to-end dry run: extract -> buildQuestions -> (mocked Jev) -> computeResult.
// No API key and no network needed. Proves the whole chain fits together and
// prints the real question count and state size per page, which is what §5.2's
// OPEN RISK (latency) will be judged against.
//
// Run: npm run dry

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { buildQuestions, buildState } from '../lib/questions.js';
import { computeResult } from '../lib/scoring.js';
import { DEFAULT_SETTINGS, DEFAULT_PREFS, EMPTY_PROFILE } from '../lib/defaults.js';

await import('../content/extract.js');
const extract = globalThis.__hhFit.extract;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(__dirname, '..', 'toBeIgnored');

// A stand-in candidate, so the numbers below are realistic.
const profile = {
  ...EMPTY_PROFILE,
  desiredPositions: 'Computer Vision Engineer, ML Engineer',
  city: 'Yekaterinburg',
  skills: ['Python', 'PyTorch', 'OpenCV', 'Docker', 'SQL', 'Linux'],
  experience: [{ company: 'Acme', role: 'ML Engineer', from: '2023', to: '2025', description: 'Trained detection models, deployed inference services.' }],
  education: 'BSc Computer Science',
  languages: 'Russian native, English B2'
};
const prefs = { ...DEFAULT_PREFS, minSalary: 120000, workFormat: 'remote' };
const settings = { ...DEFAULT_SETTINGS };

// Deterministic pseudo-random, so runs are comparable.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** Pick a key at random from a criteria dict, and build a probability map. */
function mockChoice(criteria) {
  const keys = Object.keys(criteria);
  const chosen = keys[Math.floor(rnd() * keys.length)];
  const probabilities = {};
  let total = 0;
  for (const k of keys) {
    const v = k === chosen ? 0.5 + rnd() * 0.5 : rnd() * 0.3;
    probabilities[k] = v;
    total += v;
  }
  for (const k of keys) probabilities[k] = probabilities[k] / total;
  return { type: 'choice', choice: chosen, probabilities, confidence: 0.4 + rnd() * 0.6 };
}

/** Fabricate a plausible Jev response for a question set. */
function mockAnswers(questions) {
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'score') {
      answers[key] = { type: 'score', score: Math.floor(rnd() * 5), confidence: 0.6 + rnd() * 0.4 };
    } else if (q.type === 'choice') {
      answers[key] = mockChoice(q.criteria);
    } else if (q.type === 'noul') {
      answers[key] = { type: 'noul', noul: rnd() };
    }
  }
  return answers;
}

const approxTokens = (s) => Math.ceil(String(s).replace(/[Ѐ-ӿ]/g, 'xx').length / 4);

let failures = 0;
for (const file of fs.readdirSync(CORPUS).filter((f) => f.endsWith('.html'))) {
  const dom = new JSDOM(fs.readFileSync(path.join(CORPUS, file)));
  const vacancy = extract.extractVacancy(dom.window.document, 'https://hh.ru/vacancy/1', settings.maxCandidates);

  const state = buildState(vacancy, profile, prefs);
  const { questions, reqIndex, askedSubs, computedSubs } =
    buildQuestions(vacancy, profile, prefs, settings);
  const answers = mockAnswers(questions);

  const result = computeResult({
    answers, reqIndex, askedSubs, computedSubs, settings, vacancy,
    modelVersion: 'jev-mock', usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0
  });

  const stateTok = approxTokens(JSON.stringify(state));
  const qTok = approxTokens(JSON.stringify(questions));

  console.log('=== ' + file.slice(0, 55));
  console.log(`   questions      : ${Object.keys(questions).length}  (${Object.keys(reqIndex).length} candidate lines x2, + ${askedSubs.length} subs, + flags/dealbreakers)`);
  console.log(`   state tokens   : ~${stateTok}   (limit 32k)`);
  console.log(`   question tokens: ~${qTok}`);
  console.log(`   TOTAL est      : ~${stateTok + qTok + 390} tok  ->  $${((stateTok + qTok + 390) * 0.042 / 1e6).toFixed(6)}`);
  console.log(`   overall        : ${result.overall}% (${result.band})${result.capped ? ' CAPPED' : ''}`);
  console.log(`   subs           : ${Object.entries(result.subs).map(([k, v]) => `${k}=${v.pct}%`).join(' ')}`);
  console.log(`   requirements   : ${result.requirements.length} hard, ${result.niceToHave.length} nice, ${result.eligibility.length} eligibility, ${result.softSkills.length} soft, ${result.discarded.length} dropped`);
  console.log(`   coverage       : ${result.ratedCount}/${result.hardCount} assessed` +
    (result.coverage === null ? '' : ` (${Math.round(result.coverage * 100)}%)`) +
    (result.rawPassRate === null ? '' : `  raw ${Math.round(result.rawPassRate * 100)}% -> damped ${Math.round(result.passRate * 100)}%`));
  console.log(`   task affinity  : ${result.taskAffinity}%   nice bonus: +${result.niceBonus}`);
  console.log(`   computed subs  : ${Object.entries(computedSubs).map(([k, v]) => `${k}=${v.pct}% (${v.reason})`).join('; ') || 'none'}`);
  console.log(`   flags          : ${result.flags.map((f) => f.key).join(', ') || 'none'}`);
  console.log(`   dealbreakers   : ${result.dealbreakers.map((d) => d.key).join(', ') || 'none'}`);

  // --- invariants ---
  if (stateTok > 32000) { console.log('   FAIL state exceeds the 32k limit (§3)'); failures++; }
  if (stateTok + qTok + 390 > 64000) { console.log('   FAIL request exceeds the 64k limit (§3)'); failures++; }
  if (stateTok + qTok + 390 > 52000) { console.log('   FAIL budget guard did not trim enough'); failures++; }
  if (result.overall === null) { console.log('   FAIL overall is null'); failures++; }
  if (result.overall < 0 || result.overall > 100) { console.log('   FAIL overall out of range'); failures++; }
  if (JSON.stringify(state).includes('<')) { console.log('   FAIL raw HTML leaked into state (§5.1/D5)'); failures++; }
  if (result.capped && result.overall !== settings.dealbreakerCap) { console.log('   FAIL cap not applied'); failures++; }

  // Unassessable items must never reach the pass rate, in either direction.
  const leaked = [...result.requirements, ...result.niceToHave]
    .filter((r) => r.unassessed && typeof r.fit === 'number');
  if (leaked.length) { console.log('   FAIL unassessable item carries a fit score'); failures++; }

  // Headings must not survive into the shown checklist.
  const headings = [...result.requirements, ...result.niceToHave, ...result.eligibility]
    .filter((r) => r.kind === 'heading');
  if (headings.length) { console.log('   FAIL a heading reached the checklist'); failures++; }

  // The colon pre-filter should keep obvious headers out of the harvest.
  const colonHeads = vacancy.requirementCandidates.filter((t) => extract.isHeading(t));
  if (colonHeads.length) { console.log(`   FAIL ${colonHeads.length} heading(s) survived the pre-filter`); failures++; }

  // Coverage damping must never RAISE the requirement score.
  if (result.rawPassRate !== null && result.passRate > result.rawPassRate + 1e-9) {
    console.log('   FAIL coverage damping increased the score'); failures++;
  }
  // Nice-to-haves are upside only.
  if (result.niceBonus < 0 || result.niceBonus > settings.niceToHaveBonus) {
    console.log('   FAIL nice-to-have bonus out of range'); failures++;
  }
  // Soft skills must never reach the scored set.
  if (result.requirements.some((r) => r.kind === 'soft_skill')) {
    console.log('   FAIL a soft skill was scored'); failures++;
  }
  // Short skill names must survive the harvest now.
  if (vacancy.requirementCandidates.some((t) => t.length < 5)) {
    console.log('   FAIL a sub-minimum fragment was harvested'); failures++;
  }
  console.log('');
}

console.log(failures === 0 ? 'PASS — pipeline is consistent end to end.' : `FAILED — ${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
