// Shared storage schema + defaults. ES module: used by background.js,
// options/ and popup/. NOT usable from content scripts (they cannot import).

export const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000; // $0.042 per 1M input tokens
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const CACHE_PREFIX = 'cache:';

export const DEFAULT_SETTINGS = {
  // §5.3 weights. Renormalised at runtime when a sub-score is unavailable
  // (e.g. the vacancy posted no salary).
  weights: {
    skills: 0.30,
    requirements: 0.25,
    experience: 0.20,
    domain: 0.15,
    location: 0.10
  },
  // §6.4 colour thresholds
  thresholds: { green: 75, yellow: 50 },
  // §5.2 step 3 — keep a harvested line only if is_requirement >= this
  reqThreshold: 0.60,
  // §6.4 checklist states
  reqOk: 0.70,
  reqFail: 0.40,
  // Below this, Jev's confidence earns a "check manually" marker
  lowConfidence: 0.50,
  // A dealbreaker at or above this probability caps the overall score
  dealbreakerProb: 0.70,
  dealbreakerCap: 30,
  // §5.2 — cap harvested candidates; lower this if latency disappoints
  maxCandidates: 60,
  // §6.6 debug toggle: show lines Jev rejected as non-requirements
  showDiscarded: false
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
  resumeText: ''          // fallback quick-start paste
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
