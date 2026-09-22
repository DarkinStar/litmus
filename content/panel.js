// The injected score panel. §6.4 / D6.
// Everything lives in a Shadow DOM so hh's CSS cannot leak in (and ours cannot
// leak out). Classic script — content scripts cannot use ES imports.

(function () {
  const root = (typeof window !== 'undefined' ? window : globalThis);
  root.__hhFit = root.__hhFit || {};

  const HOST_ID = 'hh-fit-scorer-host';
  const R = 42;                     // gauge radius
  const C = 2 * Math.PI * R;        // circumference

  let host = null;
  let shadow = null;
  let handlers = {};                // { onRescore, onCopyVacancy, onCopyForAi, onOpenOptions }

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  color: #1a1a1a; background: #fff; border: 1px solid #e0e3e8; border-radius: 12px;
  padding: 16px 18px; margin: 0 0 18px; box-shadow: 0 1px 3px rgba(16,24,40,.06);
}
.head { display: flex; align-items: center; gap: 12px; }
.head h2 { font-size: 15px; font-weight: 600; margin: 0; flex: 1; }
.badge { font-size: 11px; font-weight: 600; letter-spacing: .3px; text-transform: uppercase;
  padding: 3px 8px; border-radius: 999px; background: #eef1f5; color: #5a6472; }
.toggle { background: none; border: none; cursor: pointer; color: #5a6472; font-size: 13px;
  padding: 4px 8px; border-radius: 6px; }
.toggle:hover { background: #f2f4f7; }
.body { margin-top: 14px; }
.body[hidden] { display: none; }

.top { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; }
.gauge { position: relative; width: 104px; height: 104px; flex: none; }
.gauge svg { transform: rotate(-90deg); display: block; }
.gauge .num { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; }
.gauge .pct { font-size: 25px; font-weight: 700; line-height: 1; }
.gauge .cap { font-size: 10px; color: #8a929e; margin-top: 3px; letter-spacing: .4px; }
.ring-bg { stroke: #eceff3; }
.ring-fg { transition: stroke-dasharray .5s ease; stroke-linecap: round; }
.green .ring-fg, .green .pct { stroke: #129d5f; color: #129d5f; }
.yellow .ring-fg, .yellow .pct { stroke: #d99100; color: #b87d00; }
.red .ring-fg, .red .pct { stroke: #d64545; color: #d64545; }

.subs { flex: 1; min-width: 230px; display: grid; gap: 7px; }
.sub { display: grid; grid-template-columns: 132px 1fr 38px; align-items: center; gap: 10px; }
.sub .lbl { font-size: 12.5px; color: #5a6472; }
.sub .bar { height: 7px; background: #eceff3; border-radius: 4px; overflow: hidden; }
.sub .bar i { display: block; height: 100%; border-radius: 4px; background: #4a7fd6; }
.sub .val { font-size: 12.5px; font-weight: 600; text-align: right; color: #39414d; }
.sub .unsure { color: #b87d00; cursor: help; }

.section { margin-top: 16px; }
.section h3 { font-size: 12px; font-weight: 600; text-transform: uppercase;
  letter-spacing: .4px; color: #8a929e; margin: 0 0 8px; }
ul.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
ul.list li { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
.mark { flex: none; width: 16px; text-align: center; font-weight: 700; line-height: 1.5; }
.ok .mark { color: #129d5f; }
.warn .mark { color: #d99100; }
.fail .mark { color: #d64545; }
.fail .txt { color: #6b7280; }
.pct-tag { flex: none; font-size: 11px; color: #9aa2ae; margin-left: auto; padding-left: 8px; }

.alert { border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-top: 12px; }
.alert.cap { background: #fdeaea; border: 1px solid #f5c2c2; color: #a62828; }
.alert.err { background: #fdeaea; border: 1px solid #f5c2c2; color: #a62828; }
.alert.info { background: #eef4fd; border: 1px solid #c9dcf7; color: #1f4e8c; }
.alert b { font-weight: 600; }

.flags li { color: #a15c00; }
.flags .mark { color: #d99100; }

.btns { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
button.act { font: inherit; font-size: 13px; padding: 7px 13px; border-radius: 7px;
  border: 1px solid #d5dae1; background: #fff; color: #39414d; cursor: pointer; }
button.act:hover { background: #f7f9fb; border-color: #bcc4ce; }
button.act.primary { background: #2965cc; border-color: #2965cc; color: #fff; }
button.act.primary:hover { background: #2358b4; }
button.act:disabled { opacity: .5; cursor: default; }

.foot { margin-top: 12px; font-size: 11px; color: #9aa2ae; }
.spin { display: inline-block; width: 13px; height: 13px; border: 2px solid #d5dae1;
  border-top-color: #2965cc; border-radius: 50%; animation: sp .8s linear infinite;
  vertical-align: -2px; margin-right: 7px; }
@keyframes sp { to { transform: rotate(360deg); } }
details.disc { margin-top: 10px; }
details.disc summary { font-size: 12px; color: #8a929e; cursor: pointer; }
`;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /** Insert directly above the vacancy title — the most stable anchor (§4.3). */
  function anchor(doc) {
    const title = doc.querySelector('[data-qa="vacancy-title"]');
    if (title && title.parentElement) return { parent: title.parentElement, before: title };
    const main = doc.querySelector('main') || doc.body;
    return { parent: main, before: main.firstChild };
  }

  function mount() {
    const existing = document.getElementById(HOST_ID);
    if (existing) { host = existing; shadow = existing.shadowRoot; return shadow; }

    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    const slot = document.createElement('div');
    slot.className = 'slot';
    shadow.appendChild(slot);

    const { parent, before } = anchor(document);
    parent.insertBefore(host, before);
    return shadow;
  }

  function slot() {
    if (!shadow) mount();
    return shadow.querySelector('.slot');
  }

  function shell(inner, badge) {
    return `
<div class="wrap">
  <div class="head">
    <h2>Fit score</h2>
    ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
    <button class="toggle" data-act="toggle">Hide</button>
  </div>
  <div class="body">${inner}</div>
</div>`;
  }

  function wire() {
    const s = slot();
    s.querySelectorAll('[data-act]').forEach((el) => {
      el.addEventListener('click', () => {
        const act = el.getAttribute('data-act');
        if (act === 'toggle') {
          const body = s.querySelector('.body');
          const hidden = body.hasAttribute('hidden');
          if (hidden) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
          el.textContent = hidden ? 'Hide' : 'Show';
          return;
        }
        const fn = handlers[act];
        if (fn) fn(el);
      });
    });
  }

  function render(html, badge) {
    slot().innerHTML = shell(html, badge);
    wire();
  }

  // ---- public states -------------------------------------------------------

  function showLoading(msg) {
    mount();
    render(`<div class="alert info"><span class="spin"></span>${esc(msg || 'Scoring this vacancy…')}</div>`);
  }

  function showNeedsSetup(what) {
    mount();
    const msg = what === 'NO_KEY'
      ? 'Add your Jev API key to start scoring.'
      : 'Fill in your profile to start scoring — an empty profile produces meaningless scores.';
    render(`
<div class="alert info"><b>Setup needed.</b> ${esc(msg)}</div>
<div class="btns"><button class="act primary" data-act="openOptions">Open settings</button></div>`,
      'setup');
  }

  function showError(message, code) {
    mount();
    render(`
<div class="alert err"><b>Could not score this vacancy.</b><br>${esc(message)}</div>
<div class="btns">
  <button class="act primary" data-act="rescore">Try again</button>
  ${code === 'BAD_KEY' ? '<button class="act" data-act="openOptions">Open settings</button>' : ''}
</div>`, code === 'RATE_LIMIT' ? 'rate limited' : 'error');
  }

  const SUB_LABELS = {
    skills: 'Skills match',
    requirements: 'Requirements',
    experience: 'Experience level',
    location: 'Location / format',
    salary: 'Salary vs minimum',
    domain: 'Role / domain'
  };

  function gauge(overall, band) {
    const pct = overall == null ? 0 : overall;
    const dash = `${(C * pct) / 100} ${C}`;
    return `
<div class="gauge ${esc(band)}">
  <svg width="104" height="104" viewBox="0 0 104 104">
    <circle class="ring-bg" cx="52" cy="52" r="${R}" fill="none" stroke-width="9"></circle>
    <circle class="ring-fg" cx="52" cy="52" r="${R}" fill="none" stroke-width="9"
            stroke-dasharray="${dash}"></circle>
  </svg>
  <div class="num">
    <div class="pct">${overall == null ? '—' : overall + '%'}</div>
    <div class="cap">FIT</div>
  </div>
</div>`;
  }

  function subRows(result) {
    const rows = [];
    if (result.passRate !== null && result.passRate !== undefined) {
      rows.push({ key: 'requirements', pct: Math.round(result.passRate * 100), unsure: false });
    }
    for (const [key, v] of Object.entries(result.subs || {})) {
      rows.push({ key, pct: v.pct, unsure: v.unsure });
    }
    const order = ['skills', 'requirements', 'experience', 'domain', 'location', 'salary'];
    rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return rows.map((r) => `
<div class="sub">
  <span class="lbl">${esc(SUB_LABELS[r.key] || r.key)}</span>
  <span class="bar"><i style="width:${r.pct}%"></i></span>
  <span class="val">${r.pct}%${r.unsure ? ' <span class="unsure" title="Low confidence — check manually">?</span>' : ''}</span>
</div>`).join('');
  }

  const MARK = { ok: '✓', warn: '!', fail: '✕' };

  function checklist(reqs) {
    if (!reqs.length) {
      return '<div class="alert info">Jev did not identify any explicit requirements in this description.</div>';
    }
    return `<ul class="list">${reqs.map((r) => `
<li class="${esc(r.state)}">
  <span class="mark">${MARK[r.state]}</span>
  <span class="txt">${esc(r.text)}</span>
  <span class="pct-tag">${Math.round(r.fit * 100)}%</span>
</li>`).join('')}</ul>`;
  }

  function showResult(result, settings) {
    mount();
    const parts = [];

    parts.push(`<div class="top">${gauge(result.overall, result.band)}
      <div class="subs">${subRows(result)}</div></div>`);

    if (result.capped) {
      parts.push(`<div class="alert cap"><b>Score capped.</b> ${
        result.dealbreakers.map((d) => esc(d.label)).join('; ')
      }.</div>`);
    }

    parts.push(`<div class="section"><h3>Requirements (${result.requirements.length})</h3>
      ${checklist(result.requirements)}</div>`);

    if (result.flags.length) {
      parts.push(`<div class="section flags"><h3>Red flags</h3><ul class="list">${
        result.flags.map((f) => `<li><span class="mark">!</span><span class="txt">${esc(f.label)}</span>
          <span class="pct-tag">${Math.round(f.prob * 100)}%</span></li>`).join('')
      }</ul></div>`);
    }

    if (settings && settings.showDiscarded && result.discarded && result.discarded.length) {
      parts.push(`<details class="disc"><summary>${result.discarded.length} lines Jev judged not to be requirements</summary>
        <ul class="list">${result.discarded.map((d) => `<li><span class="mark">·</span>
          <span class="txt">${esc(d.text)}</span>
          <span class="pct-tag">is ${Math.round(d.isReq * 100)}%</span></li>`).join('')}</ul></details>`);
    }

    parts.push(`<div class="btns">
      <button class="act" data-act="copyVacancy">Copy vacancy</button>
      <button class="act" data-act="copyForAi">Copy for AI</button>
      <button class="act" data-act="rescore">Re-score</button>
    </div>`);

    const m = result.meta || {};
    parts.push(`<div class="foot">${esc(m.modelVersion || 'jev')} · ${m.questionCount || 0} questions · ${
      m.inputTokens || 0} tok · ${m.latencyMs ? m.latencyMs + ' ms' : ''}${
      result.fromCache ? ' · cached' : ''}</div>`);

    render(parts.join(''), result.fromCache ? 'cached' : null);
  }

  function setHandlers(h) { handlers = h || {}; }

  function destroy() {
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
    host = null; shadow = null;
  }

  root.__hhFit.panel = {
    mount, destroy, setHandlers,
    showLoading, showResult, showError, showNeedsSetup
  };
})();
