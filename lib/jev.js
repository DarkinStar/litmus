// Jev (TypeSafe AI) API client. §3.
// Request shape verified against https://docs.typesafe.ai/api.md :
//   { state, model, questions: { <key>: { type, instructions, criteria } } }
// noul   -> criteria is { "true": "...", "false": "..." }
// choice -> criteria is { option: description }
// score  -> criteria is an ordered array of level descriptions

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

export class JevError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST one batch of questions. §3 — always batch everything for a vacancy
 * into a single call; the ~390 token fixed overhead is per call, not per
 * question, and questions are evaluated in parallel.
 *
 * Retries 429 and 5xx with backoff, respecting retry-after. §2.
 */
export async function askJev({ apiKey, state, questions, maxAttempts = 3 }) {
  if (!apiKey) throw new JevError('NO_KEY', 'No API key saved.');

  const body = JSON.stringify({ state, model: JEV_MODEL, questions });
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    const startedAt = Date.now();
    try {
      res = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body
      });
    } catch (e) {
      lastErr = new JevError('NETWORK', 'Network error reaching api.typesafe.ai.');
      if (attempt < maxAttempts) { await sleep(400 * attempt); continue; }
      throw lastErr;
    }

    if (res.ok) {
      const json = await res.json();
      json._latencyMs = Date.now() - startedAt;
      return json;
    }

    if (res.status === 401 || res.status === 403) {
      throw new JevError('BAD_KEY', 'API key rejected. Check it in Settings.', res.status);
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 500 * Math.pow(2, attempt - 1);
      lastErr = new JevError(
        res.status === 429 ? 'RATE_LIMIT' : 'SERVER',
        res.status === 429 ? 'Rate limited by Jev.' : `Jev server error (${res.status}).`,
        res.status
      );
      if (attempt < maxAttempts) { await sleep(waitMs); continue; }
      throw lastErr;
    }

    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new JevError('HTTP', `Jev returned ${res.status}. ${detail}`, res.status);
  }

  throw lastErr || new JevError('UNKNOWN', 'Jev call failed.');
}

/** Cheapest possible call, for the "Test connection" button. §6.1 */
export async function testConnection(apiKey) {
  const json = await askJev({
    apiKey,
    state: 'The sky is blue.',
    questions: {
      ping: {
        type: 'noul',
        instructions: 'The state describes the sky.',
        criteria: { true: 'The state mentions the sky', false: 'It does not' }
      }
    },
    maxAttempts: 1
  });
  return {
    model: json.model,
    latencyMs: json._latencyMs,
    inputTokens: json.usage?.input_tokens ?? 0
  };
}
