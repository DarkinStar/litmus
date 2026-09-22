// Service worker. §8 — calls Jev (avoids CORS), retries, cache, usage counter.
// ES module (manifest declares "type": "module"), so it can import lib/.

import {
  getState, isProfileUsable, CACHE_PREFIX, CACHE_TTL_MS, PRICE_PER_INPUT_TOKEN, DEFAULT_USAGE
} from './lib/defaults.js';
import { askJev, testConnection, JevError } from './lib/jev.js';
import { buildQuestions, buildState } from './lib/questions.js';
import { computeResult } from './lib/scoring.js';

// §6.1 — first launch opens the options page automatically.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({ onboarded: false });
    chrome.runtime.openOptionsPage();
  }
});

// ---- cache (§2: cache by vacancy ID so revisits don't re-call) -------------

async function cacheGet(id) {
  const key = CACHE_PREFIX + id;
  const d = await chrome.storage.local.get(key);
  const hit = d[key];
  if (!hit) return null;
  if (Date.now() - (hit.meta?.scoredAt || 0) > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return hit;
}

async function cacheSet(id, result) {
  await chrome.storage.local.set({ [CACHE_PREFIX + id]: result });
}

async function cacheClear() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

// ---- usage counter (§6.6) --------------------------------------------------

async function addUsage(usage) {
  const { usage: cur } = await getState();
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const next = {
    calls: cur.calls + 1,
    inputTokens: cur.inputTokens + inTok,
    outputTokens: cur.outputTokens + outTok,
    estCostUsd: cur.estCostUsd + inTok * PRICE_PER_INPUT_TOKEN
  };
  await chrome.storage.local.set({ usage: next });
  return next;
}

// ---- scoring ---------------------------------------------------------------

async function scoreVacancy(vacancy, force) {
  const { apiKey, profile, prefs, settings } = await getState();

  if (!apiKey) throw new JevError('NO_KEY', 'No API key saved.');
  if (!isProfileUsable(profile)) throw new JevError('NO_PROFILE', 'Profile is empty.');

  if (!force && vacancy.id) {
    const hit = await cacheGet(vacancy.id);
    if (hit) return { result: { ...hit, fromCache: true }, settings };
  }

  // §3 / §5.1 — ONE call carrying every question for this vacancy.
  const state = buildState(vacancy, profile, prefs);
  const { questions, reqIndex, askedSubs } = buildQuestions(vacancy, profile, prefs, settings);

  const json = await askJev({ apiKey, state, questions });

  const result = computeResult({
    answers: json.answers || {},
    reqIndex,
    askedSubs,
    settings,
    vacancy,
    modelVersion: json.model,
    usage: json.usage,
    latencyMs: json._latencyMs
  });

  await addUsage(json.usage);
  if (vacancy.id) await cacheSet(vacancy.id, result);

  return { result, settings };
}

// ---- message router --------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'score': {
          const { result, settings } = await scoreVacancy(msg.vacancy, msg.force);
          sendResponse({ ok: true, result, settings });
          break;
        }
        case 'getSettings': {
          const { settings } = await getState();
          sendResponse(settings);
          break;
        }
        case 'getProfile': {
          const { profile } = await getState();
          sendResponse(profile);
          break;
        }
        case 'getStatus': {
          const { apiKey, profile, usage, onboarded } = await getState();
          const all = await chrome.storage.local.get(null);
          sendResponse({
            hasKey: !!apiKey,
            hasProfile: isProfileUsable(profile),
            onboarded,
            usage,
            cached: Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX)).length
          });
          break;
        }
        case 'testKey': {
          const info = await testConnection(msg.apiKey);
          sendResponse({ ok: true, info });
          break;
        }
        case 'clearCache': {
          const n = await cacheClear();
          sendResponse({ ok: true, cleared: n });
          break;
        }
        case 'resetUsage': {
          await chrome.storage.local.set({ usage: { ...DEFAULT_USAGE } });
          sendResponse({ ok: true });
          break;
        }
        case 'openOptions': {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: { code: 'BAD_MSG', message: 'Unknown message type.' } });
      }
    } catch (e) {
      sendResponse({
        ok: false,
        error: {
          code: e instanceof JevError ? e.code : 'INTERNAL',
          message: e?.message || String(e)
        }
      });
    }
  })();
  return true; // keep the channel open for the async reply
});
