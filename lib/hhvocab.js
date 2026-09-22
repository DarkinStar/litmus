// Normalisation of hh's CLOSED vocabulary fields into enums.
//
// Relationship to D4 ("never parse human-readable label text"): D4 exists to
// stop us parsing arbitrary prose, which changes constantly and fails silently.
// These fields are different — hh renders a fixed set of roughly a dozen
// strings, and the DOM carries no enum tokens for them on the vacancy page
// (checked: no noExperience/between1And3 markers outside the unrelated
// "similar vacancies" block). So a lookup table is the only route.
//
// The safety property that makes it acceptable: an unrecognised string returns
// null, and every caller falls back to handing the raw text to the model, which
// is exactly today's behaviour. Adding a language can only improve accuracy;
// missing one can never produce a WRONG number, only an unknown one.
//
// Why bother: "Experience: not required" against any candidate is a comparison,
// not a judgment. Asking a probabilistic model returned 40%.

const strip = (s) => String(s || '')
  .replace(/ /g, ' ')
  .replace(/^[^:]*:\s*/, '')   // drop the "Work format: " / "Опыт работы: " prefix
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** Experience requirement -> { key, minYears } */
const EXPERIENCE = [
  { key: 'none', minYears: 0, match: ['not required', 'не требуется', 'нет опыта'] },
  { key: '1-3', minYears: 1, match: ['1-3 years', '1–3 years', 'от 1 года до 3 лет', 'от 1 до 3 лет'] },
  { key: '3-6', minYears: 3, match: ['3-6 years', '3–6 years', 'от 3 до 6 лет'] },
  { key: '6+', minYears: 6, match: ['more than 6 years', 'более 6 лет', 'от 6 лет'] }
];

export function normalizeExperience(raw) {
  const s = strip(raw);
  if (!s) return null;
  for (const e of EXPERIENCE) {
    if (e.match.some((m) => s === m || s.includes(m))) {
      return { key: e.key, minYears: e.minYears, raw };
    }
  }
  return null;                 // unknown -> caller falls back to the model
}

/** Work format. A posting may list several, e.g. "office, remotely or hybrid". */
const FORMATS = [
  { key: 'remote', match: ['remotely', 'remote', 'удалённо', 'удаленно', 'удаленная работа'] },
  { key: 'office', match: ["at the employer's location", 'on site', 'на территории работодателя', 'в офисе'] },
  { key: 'hybrid', match: ['hybrid', 'гибрид'] },
  { key: 'field', match: ['field work', 'разъездной', 'разъездная работа'] }
];

export function normalizeWorkFormats(raw) {
  const s = strip(raw);
  if (!s) return null;
  const found = FORMATS.filter((f) => f.match.some((m) => s.includes(m))).map((f) => f.key);
  return found.length ? found : null;
}

const EMPLOYMENT = [
  { key: 'full', match: ['full-time', 'full time', 'полная занятость'] },
  { key: 'part', match: ['part-time', 'part time', 'частичная занятость'] },
  { key: 'project', match: ['project', 'проектная работа', 'проектная'] },
  { key: 'internship', match: ['internship', 'стажировка'] }
];

export function normalizeEmployment(raw) {
  const s = strip(raw);
  if (!s) return null;
  const hit = EMPLOYMENT.find((e) => e.match.some((m) => s.includes(m)));
  return hit ? hit.key : null;
}

/**
 * Deterministic experience fit, 0..100, or null when it cannot be decided
 * in code and the model should be asked instead.
 *
 * Only the "not required" case is fully decidable without knowing the
 * candidate's exact years, and it is the case that was scoring 40%.
 */
export function experienceFit(vacancyExperience) {
  const norm = normalizeExperience(vacancyExperience);
  if (!norm) return null;
  if (norm.key === 'none') return { pct: 100, reason: 'Vacancy requires no prior experience' };
  return null;
}

/**
 * Deterministic work-format fit, or null to fall through to the model.
 * Returns { pct, reason, compatible }.
 */
export function workFormatFit(vacancyWorkFormat, prefWorkFormat) {
  const formats = normalizeWorkFormats(vacancyWorkFormat);
  if (!formats || !prefWorkFormat || prefWorkFormat === 'any') return null;

  const compatible = formats.includes(prefWorkFormat);
  if (!compatible) {
    return {
      pct: 0,
      compatible: false,
      reason: `Vacancy offers ${formats.join(', ')}; you require ${prefWorkFormat}`
    };
  }
  // Remote work makes the city irrelevant, so this is fully decided.
  if (prefWorkFormat === 'remote') {
    return { pct: 100, compatible: true, reason: 'Remote, as you require' };
  }
  // Office or hybrid: the format matches but the city still matters, so let
  // the model weigh location.
  return null;
}
