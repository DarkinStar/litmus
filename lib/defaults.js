// Shared storage schema + defaults. ES module: used by background.js,
// options/ and popup/. NOT usable from content scripts (they cannot import).

export const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000; // $0.042 per 1M input tokens
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const CACHE_PREFIX = 'cache:';

export const DEFAULT_SETTINGS = {
  // §5.3 weights. Renormalised at runtime when a sub-score is unavailable
  // (e.g. the vacancy posted no salary).
  //
  // "Skills match" was removed and its weight folded into requirements: scored
  // against hh's three coarse key-skill tags it returned 100% while the
  // line-by-line checklist said 55%, contradicting itself inside one panel, and
  // it only existed on the ~2-in-3 postings that carry tags, so the score
  // composition changed silently between vacancies.
  weights: {
    requirements: 0.55,
    experience: 0.20,
    domain: 0.15,
    location: 0.10
  },
  // §6.4 colour thresholds
  thresholds: { green: 75, yellow: 50 },
  // Superseded: the binary is_requirement noul (and this threshold with it) was
  // replaced by a 6-way `kind` classifier, because no threshold could separate
  // a section heading from a real requirement. Kept only so old stored settings
  // deserialise cleanly; nothing reads it.
  reqThreshold: 0.60,
  // §6.4 checklist states, applied to the continuous fit derived from the
  // satisfaction choice (see lib/scoring.js).
  reqOk: 0.70,
  reqFail: 0.40,
  // Nice-to-haves are upside only — they add points, never subtract. This is
  // the maximum they can add to the overall score.
  niceToHaveBonus: 5,
  // Damping floor for thin coverage. requirement component is multiplied by
  // floor + (1-floor)*coverage, so a profile that leaves most requirements
  // unassessable cannot post a confident high score, while a fully assessed
  // one is untouched. At 0.7, zero coverage retains 70% rather than collapsing.
  coverageFloor: 0.70,
  // Below this, Jev's confidence earns a "check manually" marker
  lowConfidence: 0.50,
  // A dealbreaker at or above this probability caps the overall score
  dealbreakerProb: 0.70,
  dealbreakerCap: 30,
  // §5.2 — cap harvested candidates; lower this if latency disappoints
  maxCandidates: 60,
  // §6.6 debug toggle: show lines the classifier dropped, and why
  showDiscarded: false,
  // Show the exact extracted vacancy object and the state sent to Jev, in the
  // panel. Without this, diagnosing a low sub-score is guesswork.
  showDebug: false
};

export const DEFAULT_PREFS = {
  workFormat: 'any',      // any | remote | office | hybrid
  relocation: false,
  minSalary: null,
  employment: 'any',      // any | full | part | project | internship
  targetLevel: 'any'      // any | intern | junior | middle | senior
};

export const EMPTY_PROFILE = {
  desiredPositions: '',
  experience: [],         // { company, role, from, to, description }
  education: '',
  skills: [],
  projects: [],           // { name, description, achievements, tech }
  languages: '',
  city: '',
  resumeText: '',         // fallback quick-start paste

  // Availability / eligibility. Added after the first live run: internship and
  // junior postings test these constantly ("30–40 часов в неделю", "4 курс
  // бакалавриата"), and without them the model has nothing to judge against
  // and returns a meaningless mid-range probability.
  status: '',             // student | working | seeking | ''
  studyYear: '',          // free text: "4 курс бакалавриата", "1 курс магистратуры"
  hoursPerWeek: '',       // free text: "40", "30-40", "part-time"
  earliestStart: '',      // free text: "immediately", "June 2026"
  workAuthorization: ''   // free text: citizenship / permit, if relevant
};

export const DEFAULT_USAGE = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estCostUsd: 0
};

/**
 * §6.1 / D7 — scoring stays disabled until the profile is meaningfully filled.
 * Either the structured fields carry real content, or the quick-start paste does.
 */
export function isProfileUsable(profile) {
  if (!profile) return false;
  if ((profile.resumeText || '').trim().length >= 120) return true;
  const hasRole = (profile.desiredPositions || '').trim().length > 0;
  const hasSubstance =
    (profile.skills || []).length > 0 ||
    (profile.experience || []).length > 0 ||
    (profile.projects || []).length > 0;
  return hasRole && hasSubstance;
}

export async function getState() {
  const d = await chrome.storage.local.get([
    'apiKey', 'profile', 'prefs', 'settings', 'usage', 'onboarded'
  ]);
  const p = d.profile || {};
  return {
    apiKey: d.apiKey || '',
    // Arrays are cloned, not spread from EMPTY_PROFILE: sharing the module-level
    // array would let a push() on an empty profile mutate the defaults for every
    // later getState() in this worker.
    profile: {
      ...EMPTY_PROFILE,
      ...p,
      skills: Array.isArray(p.skills) ? [...p.skills] : [],
      experience: Array.isArray(p.experience) ? p.experience.map((e) => ({ ...e })) : [],
      projects: Array.isArray(p.projects) ? p.projects.map((e) => ({ ...e })) : []
    },
    prefs: { ...DEFAULT_PREFS, ...(d.prefs || {}) },
    settings: {
      ...DEFAULT_SETTINGS,
      ...(d.settings || {}),
      weights: { ...DEFAULT_SETTINGS.weights, ...((d.settings || {}).weights || {}) },
      thresholds: { ...DEFAULT_SETTINGS.thresholds, ...((d.settings || {}).thresholds || {}) }
    },
    usage: { ...DEFAULT_USAGE, ...(d.usage || {}) },
    onboarded: !!d.onboarded
  };
}
