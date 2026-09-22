// Persistent log of every vacancy scored. §7 v2.
//
// Separate from the cache on purpose: the cache is a latency/cost optimisation
// and is safe to clear at any time, while history is the raw material for skill
// gap analysis ("Docker missing in 14 of 30 vacancies you viewed"). Clearing
// the cache must never destroy it.
//
// Written now rather than with the v2 UI because every vacancy browsed before
// this exists is data that cannot be recovered later.

export const HISTORY_PREFIX = 'hist:';
export const HISTORY_VERSION = 1;

/**
 * A deliberately compact record — the full result stays in the cache. This
 * keeps chrome.storage.local small enough to hold thousands of entries.
 */
export function toRecord(result, vacancy) {
  const line = (r) => ({ t: r.text, k: r.kind, s: r.state, f: r.fit == null ? null : Math.round(r.fit * 100) });
  return {
    v: HISTORY_VERSION,
    id: vacancy.id,
    url: vacancy.url,
    title: vacancy.title,
    company: vacancy.company,
    city: vacancy.location,
    salary: vacancy.salary ? { min: vacancy.salary.min, max: vacancy.salary.max, cur: vacancy.salary.currency } : null,
    experience: vacancy.experience,
    workFormat: vacancy.workFormat,
    keySkills: vacancy.keySkills || [],
    scoredAt: result.meta?.scoredAt || Date.now(),
    overall: result.overall,
    taskAffinity: result.taskAffinity ?? null,
    coverage: result.coverage,
    subs: Object.fromEntries(Object.entries(result.subs || {}).map(([k, v]) => [k, v.pct])),
    // The checklist is the part skill-gap analysis actually reads.
    lines: [
      ...(result.requirements || []),
      ...(result.niceToHave || []),
      ...(result.eligibility || [])
    ].map(line),
    flags: (result.flags || []).map((f) => f.key),
    dealbreakers: (result.dealbreakers || []).map((d) => d.key),
    // v2: user-set application status. Null until the tracker UI exists.
    status: null
  };
}

export async function record(result, vacancy) {
  if (!vacancy?.id) return;
  const key = HISTORY_PREFIX + vacancy.id;
  const existing = (await chrome.storage.local.get(key))[key];
  const entry = toRecord(result, vacancy);
  // Preserve a status the user set earlier; re-scoring must not wipe it.
  if (existing && existing.status) entry.status = existing.status;
  if (existing && existing.firstSeen) entry.firstSeen = existing.firstSeen;
  else entry.firstSeen = entry.scoredAt;
  await chrome.storage.local.set({ [key]: entry });
}

export async function all() {
  const everything = await chrome.storage.local.get(null);
  return Object.entries(everything)
    .filter(([k]) => k.startsWith(HISTORY_PREFIX))
    .map(([, v]) => v)
    .sort((a, b) => (b.scoredAt || 0) - (a.scoredAt || 0));
}

export async function count() {
  const everything = await chrome.storage.local.get(null);
  return Object.keys(everything).filter((k) => k.startsWith(HISTORY_PREFIX)).length;
}

/**
 * Aggregate unmet requirements across everything seen so far. This is the
 * payload for "what should I learn next" — the reason history exists.
 */
export async function skillGaps({ minCount = 2 } = {}) {
  const rows = await all();
  const buckets = new Map();
  for (const row of rows) {
    for (const l of row.lines || []) {
      if (l.k !== 'hard_requirement') continue;
      if (l.s !== 'fail' && l.s !== 'unknown') continue;
      const key = l.t.toLowerCase().trim();
      if (!buckets.has(key)) buckets.set(key, { text: l.t, missing: 0, unknown: 0, vacancies: [] });
      const b = buckets.get(key);
      if (l.s === 'unknown') b.unknown++; else b.missing++;
      b.vacancies.push({ id: row.id, title: row.title });
    }
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, total: b.missing + b.unknown }))
    .filter((b) => b.total >= minCount)
    .sort((a, b) => b.total - a.total);
}

export async function exportCsv() {
  const rows = await all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['id', 'title', 'company', 'city', 'overall', 'taskAffinity', 'coverage', 'scoredAt', 'status', 'url'];
  const body = rows.map((r) => [
    r.id, r.title, r.company, r.city, r.overall, r.taskAffinity,
    r.coverage == null ? '' : Math.round(r.coverage * 100),
    new Date(r.scoredAt).toISOString(), r.status || '', r.url
  ].map(esc).join(','));
  return [head.join(','), ...body].join('\n');
}

export async function clear() {
  const everything = await chrome.storage.local.get(null);
  const keys = Object.keys(everything).filter((k) => k.startsWith(HISTORY_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}
