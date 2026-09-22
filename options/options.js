// Onboarding wizard + profile + preferences + settings. §6.1 / §6.6.
import {
  getState, DEFAULT_SETTINGS, DEFAULT_PREFS, EMPTY_PROFILE, isProfileUsable
} from '../lib/defaults.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

let state = null;
let saveTimer = null;

// ---- step navigation -------------------------------------------------------

function go(step) {
  document.querySelectorAll('[data-panel]').forEach((p) => {
    p.hidden = p.dataset.panel !== String(step);
  });
  document.querySelectorAll('.step').forEach((b) => {
    b.classList.toggle('active', b.dataset.step === String(step));
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => go(b.dataset.step)));
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// ---- repeatable cards (experience / projects) ------------------------------

const EXP_FIELDS = [
  ['company', 'Company', 'text'],
  ['role', 'Role', 'text'],
  ['from', 'From', 'text'],
  ['to', 'To', 'text'],
  ['description', 'What you did', 'textarea']
];
const PROJ_FIELDS = [
  ['name', 'Project name', 'text'],
  ['tech', 'Tech used', 'text'],
  ['description', 'Description', 'textarea'],
  ['achievements', 'Achievements', 'textarea']
];

function renderCards(container, items, fields, onChange) {
  container.innerHTML = '';
  items.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    const grid = document.createElement('div');
    grid.className = 'grid';

    fields.forEach(([key, label, type]) => {
      const wrap = document.createElement('label');
      if (type === 'textarea') wrap.className = 'full';
      wrap.textContent = label;
      const el = document.createElement(type === 'textarea' ? 'textarea' : 'input');
      if (type !== 'textarea') el.type = 'text';
      else el.rows = 2;
      el.value = item[key] || '';
      el.addEventListener('input', () => { item[key] = el.value; onChange(); });
      wrap.appendChild(el);
      grid.appendChild(wrap);
    });

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', () => {
      items.splice(i, 1);
      renderCards(container, items, fields, onChange);
      onChange();
    });

    card.appendChild(grid);
    card.appendChild(rm);
    container.appendChild(card);
  });
}

// ---- weights ---------------------------------------------------------------

const WEIGHT_LABELS = {
  skills: 'Skills match',
  requirements: 'Requirement checklist',
  experience: 'Experience level',
  domain: 'Role / domain',
  location: 'Location / format'
};

function renderWeights() {
  const box = $('weights');
  box.className = 'grid two';
  box.innerHTML = '';
  for (const [key, label] of Object.entries(WEIGHT_LABELS)) {
    const l = document.createElement('label');
    l.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '0'; inp.max = '1'; inp.step = '0.05';
    inp.value = state.settings.weights[key];
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      state.settings.weights[key] = Number.isFinite(v) ? v : 0;
      queueSave();
    });
    l.appendChild(inp);
    box.appendChild(l);
  }
}

// ---- load / save -----------------------------------------------------------

function fillForm() {
  $('apiKey').value = state.apiKey;

  const p = state.profile;
  $('desiredPositions').value = p.desiredPositions || '';
  $('city').value = p.city || '';
  $('skills').value = (p.skills || []).join(', ');
  $('education').value = p.education || '';
  $('languages').value = p.languages || '';
  $('resumeText').value = p.resumeText || '';
  renderCards($('expList'), p.experience, EXP_FIELDS, queueSave);
  renderCards($('projList'), p.projects, PROJ_FIELDS, queueSave);

  const pr = state.prefs;
  $('workFormat').value = pr.workFormat;
  $('relocation').checked = !!pr.relocation;
  $('minSalary').value = pr.minSalary ?? '';
  $('employment').value = pr.employment;
  $('targetLevel').value = pr.targetLevel;

  const s = state.settings;
  $('thGreen').value = s.thresholds.green;
  $('thYellow').value = s.thresholds.yellow;
  $('reqThreshold').value = s.reqThreshold;
  $('maxCandidates').value = s.maxCandidates;
  $('reqOk').value = s.reqOk;
  $('reqFail').value = s.reqFail;
  $('showDiscarded').checked = !!s.showDiscarded;
  $('dealbreakerProb').value = s.dealbreakerProb;
  $('dealbreakerCap').value = s.dealbreakerCap;
  renderWeights();
}

function readForm() {
  state.apiKey = $('apiKey').value.trim();

  const p = state.profile;
  p.desiredPositions = $('desiredPositions').value;
  p.city = $('city').value;
  p.skills = $('skills').value.split(',').map((s) => s.trim()).filter(Boolean);
  p.education = $('education').value;
  p.languages = $('languages').value;
  p.resumeText = $('resumeText').value;

  const num = (id) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : null;
  };

  state.prefs = {
    workFormat: $('workFormat').value,
    relocation: $('relocation').checked,
    minSalary: num('minSalary'),
    employment: $('employment').value,
    targetLevel: $('targetLevel').value
  };

  const s = state.settings;
  s.thresholds = { green: num('thGreen') ?? 75, yellow: num('thYellow') ?? 50 };
  s.reqThreshold = num('reqThreshold') ?? DEFAULT_SETTINGS.reqThreshold;
  s.maxCandidates = num('maxCandidates') ?? DEFAULT_SETTINGS.maxCandidates;
  s.reqOk = num('reqOk') ?? DEFAULT_SETTINGS.reqOk;
  s.reqFail = num('reqFail') ?? DEFAULT_SETTINGS.reqFail;
  s.showDiscarded = $('showDiscarded').checked;
  s.dealbreakerProb = num('dealbreakerProb') ?? DEFAULT_SETTINGS.dealbreakerProb;
  s.dealbreakerCap = num('dealbreakerCap') ?? DEFAULT_SETTINGS.dealbreakerCap;
}

async function save() {
  readForm();
  await chrome.storage.local.set({
    apiKey: state.apiKey,
    profile: state.profile,
    prefs: state.prefs,
    settings: state.settings,
    onboarded: !!state.apiKey && isProfileUsable(state.profile)
  });
  const el = $('saveState');
  el.textContent = 'Saved';
  el.classList.add('flash');
  setTimeout(() => {
    el.textContent = 'All changes save automatically';
    el.classList.remove('flash');
  }, 1200);
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

// ---- wiring ----------------------------------------------------------------

function result(el, msg, good) {
  el.textContent = msg;
  el.className = 'result show ' + (good ? 'good' : 'bad');
}

$('toggleKey').addEventListener('click', () => {
  const f = $('apiKey');
  const show = f.type === 'password';
  f.type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? 'Hide' : 'Show';
});

$('testKey').addEventListener('click', async () => {
  const btn = $('testKey');
  const key = $('apiKey').value.trim();
  const box = $('keyResult');
  if (!key) return result(box, 'Enter a key first.', false);

  btn.disabled = true;
  btn.textContent = 'Testing…';
  await save();
  const r = await send({ type: 'testKey', apiKey: key });
  btn.disabled = false;
  btn.textContent = 'Test connection';

  if (r?.ok) {
    result(box, `Connected. Model ${r.info.model}, ${r.info.latencyMs} ms, ${r.info.inputTokens} input tokens.`, true);
  } else {
    result(box, r?.error?.message || 'Connection failed.', false);
  }
});

$('addExp').addEventListener('click', () => {
  state.profile.experience.push({ company: '', role: '', from: '', to: '', description: '' });
  renderCards($('expList'), state.profile.experience, EXP_FIELDS, queueSave);
});
$('addProj').addEventListener('click', () => {
  state.profile.projects.push({ name: '', tech: '', description: '', achievements: '' });
  renderCards($('projList'), state.profile.projects, PROJ_FIELDS, queueSave);
});

$('exportBtn').addEventListener('click', async () => {
  await save();
  // The API key is deliberately NOT exported (§2).
  const blob = new Blob([JSON.stringify({
    profile: state.profile, prefs: state.prefs, settings: state.settings
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hh-fit-scorer-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  result($('dataResult'), 'Exported. The API key is not included, by design.', true);
});

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.profile) state.profile = { ...EMPTY_PROFILE, ...data.profile };
    if (data.prefs) state.prefs = { ...DEFAULT_PREFS, ...data.prefs };
    if (data.settings) {
      state.settings = {
        ...DEFAULT_SETTINGS, ...data.settings,
        weights: { ...DEFAULT_SETTINGS.weights, ...(data.settings.weights || {}) },
        thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(data.settings.thresholds || {}) }
      };
    }
    fillForm();
    await save();
    result($('dataResult'), 'Imported.', true);
  } catch (err) {
    result($('dataResult'), 'Could not read that file: ' + err.message, false);
  }
  e.target.value = '';
});

$('clearCache').addEventListener('click', async () => {
  const r = await send({ type: 'clearCache' });
  result($('dataResult'), `Cleared ${r?.cleared ?? 0} cached vacancy score(s).`, true);
});

$('resetUsage').addEventListener('click', async () => {
  await send({ type: 'resetUsage' });
  result($('dataResult'), 'Usage counter reset.', true);
});

document.addEventListener('input', (e) => {
  if (e.target.closest('.card')) return; // cards handle their own input
  queueSave();
});

// ---- boot ------------------------------------------------------------------

(async function boot() {
  state = await getState();
  fillForm();
  // Land on the first unfinished step.
  if (!state.apiKey) go(1);
  else if (!isProfileUsable(state.profile)) go(2);
  else go(1);
})();
