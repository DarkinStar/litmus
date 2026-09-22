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
}

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('clearCache').addEventListener('click', async () => {
  await send({ type: 'clearCache' });
  refresh();
});

refresh();
