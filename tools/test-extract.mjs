// §9 REGRESSION RULE — extract.js must produce sane output on all three saved
// pages in toBeIgnored/ after any change. They are deliberately structurally
// different (see §4.5). Run: npm test
//
// This is a sanity harness, not a unit-test suite: it prints what was
// extracted and fails loudly on the things the spec says must never happen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// extract.js is a classic script: its IIFE attaches to globalThis in Node,
// so importing it for side effects is enough. No CommonJS shim needed.
await import('../content/extract.js');
const extract = globalThis.__hhFit.extract;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(__dirname, '..', 'toBeIgnored');

// §4 — what each page must yield. Ids are from the JSON-LD identifier.value.
const EXPECTED = [
  { match: 'AI Automation',  id: '137637713', hasSalary: true,  minCandidates: 30 },
  { match: 'компьютерного',  id: '137571614', hasSalary: true,  minCandidates: 10 },
  { match: 'веб-аналитик',   id: '137510416', hasSalary: false, minCandidates: 15 }
];

let failures = 0;
const fail = (msg) => { console.log('   FAIL  ' + msg); failures++; };
const ok = (msg) => console.log('   ok    ' + msg);

if (!fs.existsSync(CORPUS)) {
  console.error('Corpus missing: ' + CORPUS);
  process.exit(1);
}

const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.html'));
console.log(`Found ${files.length} saved page(s) in toBeIgnored/\n`);

for (const file of files) {
  const expected = EXPECTED.find((e) => file.includes(e.match));
  const dom = new JSDOM(fs.readFileSync(path.join(CORPUS, file)));
  const url = `https://hh.ru/vacancy/${expected ? expected.id : '0'}`;
  const v = extract.extractVacancy(dom.window.document, url, 60);

  console.log('=== ' + file.slice(0, 60));
  console.log('   title      : ' + v.title);
  console.log('   company    : ' + v.company);
  console.log('   id         : ' + v.id);
  console.log('   location   : ' + v.location);
  console.log('   salary     : ' + (v.salary ? `${v.salary.min}–${v.salary.max} ${v.salary.currency} gross=${v.salary.gross}` : 'null (not posted)'));
  console.log('   experience : ' + v.experience);
  console.log('   format     : ' + v.workFormat);
  console.log('   employment : ' + v.employment);
  console.log('   keySkills  : ' + (v.keySkills.length ? v.keySkills.length + ' tags' : 'none'));
  console.log('   desc chars : ' + (v.descriptionText || '').length);
  console.log('   candidates : ' + v.requirementCandidates.length);

  // --- invariants the spec demands ---
  if (!v.title) fail('title is null — §4.1/§4.3 say it is present 3/3');
  else ok('title');

  if (!v.company) fail('company is null — present 3/3');
  else ok('company');

  if (!v.id) fail('id is null — it is the cache key (§6.3)');
  else if (expected && v.id !== expected.id) fail(`id ${v.id} != expected ${expected.id}`);
  else ok('id');

  if (!v.experience) fail('experience is null — present 3/3');
  else ok('experience');

  if (!v.workFormat) fail('workFormat is null — present 3/3');
  else ok('workFormat');

  if (!v.descriptionText || v.descriptionText.length < 200) fail('description too short');
  else ok('description');

  if (expected) {
    if (expected.hasSalary && !v.salary) fail('expected a salary here');
    else if (!expected.hasSalary && v.salary) fail('expected NO salary here (§5.3: absent = neutral)');
    else ok('salary presence matches §4.3');

    // §5.2 — the whole point of D3: every page must yield candidates,
    // including page A which has ZERO <li>.
    if (v.requirementCandidates.length < expected.minCandidates) {
      fail(`only ${v.requirementCandidates.length} candidates, expected >= ${expected.minCandidates}`);
    } else ok(`harvest produced ${v.requirementCandidates.length} candidates`);
  }

  // D3 regression guard: the old <li>-only rule would return 0 here.
  const liOnly = dom.window.document.querySelectorAll('[data-qa="vacancy-description"] li').length;
  if (liOnly === 0 && v.requirementCandidates.length > 0) {
    ok(`D3 confirmed: 0 <li> on this page, harvest still found ${v.requirementCandidates.length}`);
  }

  console.log('');
}

console.log(failures === 0
  ? `PASS — all invariants held across ${files.length} pages.`
  : `FAILED — ${failures} invariant(s) broken.`);
process.exit(failures === 0 ? 0 : 1);
