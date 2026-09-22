// Vacancy extraction. Implements §4 and §5.2 step 1.
//
// Hard rules from the spec, verified against the 3 pages in toBeIgnored/:
//   D1  JSON-LD MERGED WITH data-qa. Neither alone is enough (§4.1).
//   D2  HH-Lux-InitialState is empty after hydration. Not used (§4.2).
//   D4  Never match on human-readable label text; the UI renders in English
//       on this account. Numbers via digit regex, tax status via data-qa (§4.4).
//   §4.3 No CSS classes, ever.
//
// Written as a classic script (content scripts cannot use ES imports) but it
// exports under CommonJS too, so tools/test-extract.js can run it in jsdom.

(function () {
  const root = (typeof window !== 'undefined' ? window : globalThis);
  root.__hhFit = root.__hhFit || {};

  const VACANCY_URL_RE = /^https:\/\/([a-z0-9-]+\.)?hh\.ru\/vacancy\/(\d+)/i;

  function vacancyIdFromUrl(url) {
    const m = String(url || '').match(VACANCY_URL_RE);
    return m ? m[2] : null;
  }

  function isVacancyUrl(url) {
    return VACANCY_URL_RE.test(String(url || ''));
  }

  const clean = (s) =>
    String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  function qa(doc, name) {
    return doc.querySelector(`[data-qa="${name}"]`);
  }

  function qaText(doc, name) {
    const el = qa(doc, name);
    return el ? clean(el.textContent) || null : null;
  }

  /** §4.1 — JSON-LD JobPosting. Present on 3/3, but missing salary/experience/skills. */
  function readJsonLd(doc) {
    const nodes = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const n of nodes) {
      let parsed;
      try { parsed = JSON.parse(n.textContent); } catch { continue; }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && item['@type'] === 'JobPosting') return item;
      }
    }
    return null;
  }

  /**
   * §4.4 — locale-agnostic salary parsing.
   * We do NOT try to tell "from" from "up to": those are words, and words
   * change with locale. We keep every number found, expose min/max, and pass
   * the raw string through for Jev to read as text.
   */
  function parseSalary(doc) {
    const raw = qaText(doc, 'vacancy-salary');
    if (!raw) return null;

    const nums = (raw.match(/\d[\d\s ]*/g) || [])
      .map((s) => parseInt(s.replace(/[\s ]/g, ''), 10))
      .filter((n) => Number.isFinite(n) && n >= 1000); // guard against stray digits

    // Tax status comes from the data-qa marker, never from the words. §4.3
    const typeEl = doc.querySelector('[data-qa^="vacancy-salary-compensation-type-"]');
    let gross = null;
    if (typeEl) {
      const suffix = typeEl.getAttribute('data-qa').split('vacancy-salary-compensation-type-')[1];
      if (suffix === 'gross') gross = true;
      else if (suffix === 'net') gross = false;
    }

    let currency = null;
    if (/[₽]|руб|RUR|RUB/i.test(raw)) currency = 'RUB';
    else if (/\$|USD/i.test(raw)) currency = 'USD';
    else if (/€|EUR/i.test(raw)) currency = 'EUR';
    else if (/₸|KZT/i.test(raw)) currency = 'KZT';

    return {
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      currency,
      gross,
      raw
    };
  }

  /** §4.3 — key-skill tags. Present on 2/3; a bonus signal, never required. */
  function keySkills(doc) {
    return [...doc.querySelectorAll('[data-qa="skills-element"]')]
      .map((el) => clean(el.textContent))
      .filter(Boolean);
  }

  /**
   * §5.2 step 1 — HARVEST, deliberately generous.
   * Every leaf <li> AND every leaf <p>. No keywords, no structural assumptions,
   * no language assumptions. Jev discards the non-requirements in step 3.
   * Measured counts on the test corpus: A=65, B=15, C=23.
   */
  function harvestRequirementCandidates(descEl, cap) {
    if (!descEl) return [];
    const out = [];
    const seen = new Set();
    for (const el of descEl.querySelectorAll('li, p')) {
      if (el.querySelector('li, p')) continue;          // containers, not leaves
      const t = clean(el.textContent);
      if (t.length < 15 || t.length > 300) continue;
      if (isHeading(t)) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= (cap || 60)) break;
    }
    return out;
  }

  /**
   * Cheap pre-filter for section headings, to stop them reaching the model at
   * all. Keys off PUNCTUATION and shape, never on label words, so it stays
   * locale-independent and does not violate D4: a short line ending in a colon
   * ("Требования:", "Requirements:", "Мы ожидаем:") is a header in any language.
   * The `kind` classifier is still the real defence; this just saves the tokens.
   */
  function isHeading(t) {
    if (!/[:：]$/.test(t)) return false;
    if (t.length > 80) return false;        // a long line ending in ':' is prose
    // A colon-terminated line packed with separators is a list written inline,
    // not a header — keep it.
    if ((t.match(/[,;]/g) || []).length >= 3) return false;
    return true;
  }

  /** Readable plain text of the description, for §5.1 state and the copy button. */
  function descriptionText(descEl) {
    if (!descEl) return null;
    const parts = [];
    for (const el of descEl.querySelectorAll('li, p, strong, h1, h2, h3')) {
      if (el.querySelector('li, p')) continue;
      const t = clean(el.textContent);
      if (t) parts.push(t);
    }
    if (!parts.length) return clean(descEl.textContent) || null;
    // Dedupe: <strong> inside a <p> would otherwise appear twice.
    const seen = new Set();
    return parts.filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).join('\n');
  }

  /**
   * Build the vacancy object. Every field degrades to null rather than throwing (§4.3).
   * @param {Document} doc
   * @param {string} url
   * @param {number} cap  max harvested candidates (settings.maxCandidates)
   */
  function extractVacancy(doc, url, cap) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    url = url || (typeof location !== 'undefined' ? location.href : '');
    if (!doc) return null;

    const ld = readJsonLd(doc);
    const descEl = qa(doc, 'vacancy-description');

    // D1 — merge. JSON-LD is the more stable source for these four; data-qa
    // is the fallback when the block is absent or malformed.
    const title = clean(ld?.title) || qaText(doc, 'vacancy-title');
    const company = clean(ld?.hiringOrganization?.name) || qaText(doc, 'vacancy-company-name');
    const id = (ld?.identifier?.value != null ? String(ld.identifier.value) : null)
      || vacancyIdFromUrl(url);

    const addr = ld?.jobLocation?.address || {};
    const location_ = clean(addr.addressLocality)
      || qaText(doc, 'vacancy-view-raw-address')
      || qaText(doc, 'vacancy-address-with-map')
      || null;

    return {
      id,
      url,
      title: title || null,
      company: company || null,
      location: location_,
      region: clean(addr.addressRegion) || null,
      country: clean(addr.addressCountry) || null,
      datePosted: ld?.datePosted || null,
      validThrough: ld?.validThrough || null,

      // §4.1 — these four exist ONLY in the DOM, never in JSON-LD.
      salary: parseSalary(doc),
      experience: qaText(doc, 'vacancy-experience') || qaText(doc, 'work-experience-text'),
      workFormat: qaText(doc, 'work-formats-text'),
      employment: qaText(doc, 'common-employment-text'),
      keySkills: keySkills(doc),

      descriptionText: descriptionText(descEl),
      requirementCandidates: harvestRequirementCandidates(descEl, cap),
      extractedAt: Date.now()
    };
  }

  /** §6.5 — clean plain text, no hh clutter. */
  function toPlainText(v) {
    const lines = [
      v.title,
      v.company ? `Company: ${v.company}` : null,
      v.location ? `Location: ${v.location}` : null,
      v.salary?.raw ? `Salary: ${v.salary.raw}` : null,
      v.experience ? `Experience: ${v.experience}` : null,
      v.workFormat,
      v.employment,
      v.keySkills?.length ? `Key skills: ${v.keySkills.join(', ')}` : null,
      '',
      v.descriptionText,
      '',
      v.url
    ];
    return lines.filter((l) => l !== null && l !== undefined).join('\n');
  }

  const api = {
    extractVacancy,
    isVacancyUrl,
    vacancyIdFromUrl,
    harvestRequirementCandidates,
    isHeading,
    parseSalary,
    toPlainText
  };

  root.__hhFit.extract = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
