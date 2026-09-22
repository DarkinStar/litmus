// Quick status + usage counter. §6.6. (v2 will add the application tracker.)

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function setDot(dotId, labelId, on, onText, offText) {
  $(dotId).className = 'dot ' + (on ? 'on' : 'off');
  $(labelId).textContent = on ? onText : offText;
}

async function refresh() {
  const s = await send({ type: 'getStatus' });
  if (!s) return;

  setDot('dotKey', 'keyState', s.hasKey, 'saved', 'missing');
  setDot('dotProfile', 'profileState', s.hasProfile, 'ready', 'empty');

  $('calls').textContent = s.usage.calls.toLocaleString();
  $('tokens').textContent = s.usage.inputTokens.toLocaleString();
  $('cost').textContent = '$' + s.usage.estCostUsd.toFixed(4);
  $('cached').textContent = s.cached;
  $('tracked').textContent = s.tracked ?? 0;

  const g = await send({ type: 'getSkillGaps', minCount: 2 });
  const box = $('gaps');
  if (!g?.gaps?.length) {
    box.textContent = s.tracked
      ? 'No gap appears in 2+ vacancies yet.'
      : 'Nothing tracked yet — score a few vacancies.';
    return;
  }
  box.innerHTML = g.gaps.slice(0, 8).map((x) => `
    <div class="gap"><span class="t" title="${x.text.replace(/"/g, '&quot;')}">${
      x.text.length > 46 ? x.text.slice(0, 46) + '…' : x.text
    }</span><span class="n">${x.total}</span></div>`).join('');
}

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('clearCache').addEventListener('click', async () => {
  await send({ type: 'clearCache' });
  refresh();
});

$('exportCsv').addEventListener('click', async () => {
  const r = await send({ type: 'exportHistoryCsv' });
  if (!r?.csv) return;
  const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `litmus-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

refresh();
