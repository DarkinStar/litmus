// Detection + orchestration. §6.2.
//
// The content script is matched against ALL of *.hh.ru rather than only
// /vacancy/*, deliberately: hh is a SPA and navigating from search results to
// a vacancy does not re-inject content scripts. Watching the URL ourselves
// avoids needing the "webNavigation" permission, which §2 rules out.

(function () {
  const { extract, panel } = window.__hhFit;

  let currentId = null;
  let inFlight = false;
  let lastVacancy = null;

  function copy(text) {
    navigator.clipboard.writeText(text).catch(() => {
      // Clipboard can be refused when the document is not focused; fall back.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    });
  }

  function flash(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = original; }, 1400);
  }

  /** §6.5 — vacancy text + profile + a ready cover-letter prompt. */
  function buildAiPrompt(vacancy, profile) {
    const prof = [
      profile.desiredPositions ? `Desired position: ${profile.desiredPositions}` : '',
      profile.city ? `City: ${profile.city}` : '',
      (profile.skills || []).length ? `Skills: ${profile.skills.join(', ')}` : '',
      (profile.experience || []).length
        ? 'Experience:\n' + profile.experience
            .map((e) => `- ${e.role || ''} @ ${e.company || ''} (${e.from || ''}–${e.to || ''}): ${e.description || ''}`)
            .join('\n')
        : '',
      (profile.projects || []).length
        ? 'Projects:\n' + profile.projects
            .map((p) => `- ${p.name || ''}: ${p.description || ''} [${p.tech || ''}] ${p.achievements || ''}`)
            .join('\n')
        : '',
      profile.education ? `Education: ${profile.education}` : '',
      profile.languages ? `Languages: ${profile.languages}` : '',
      profile.resumeText ? `Resume:\n${profile.resumeText}` : ''
    ].filter(Boolean).join('\n');

    return [
      'Write a tailored cover letter for this vacancy based on my profile.',
      'Keep it concise, concrete, and in the language of the vacancy.',
      'Lead with the strongest match between my background and their requirements.',
      '',
      '--- VACANCY ---',
      extract.toPlainText(vacancy),
      '',
      '--- MY PROFILE ---',
      prof
    ].join('\n');
  }

  async function score(force) {
    if (inFlight) return;
    inFlight = true;
    try {
      const settings = await ask({ type: 'getSettings' });
      const vacancy = extract.extractVacancy(document, location.href, settings?.maxCandidates || 60);
      lastVacancy = vacancy;

      if (!vacancy || !vacancy.id) { panel.destroy(); return; }

      panel.mount();
      panel.showLoading(force ? 'Re-scoring…' : 'Scoring this vacancy…');

      const res = await ask({ type: 'score', vacancy, force: !!force });

      if (res && res.ok) {
        lastResult = res.result;
        panel.showResult(res.result, res.settings);
      } else if (res && (res.error?.code === 'NO_KEY' || res.error?.code === 'NO_PROFILE')) {
        panel.showNeedsSetup(res.error.code);
      } else {
        panel.showError(res?.error?.message || 'Unknown error.', res?.error?.code);
      }
    } catch (e) {
      panel.showError(e?.message || String(e));
    } finally {
      inFlight = false;
    }
  }

  function ask(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: { code: 'DISCONNECTED', message: chrome.runtime.lastError.message } });
          } else resolve(r);
        });
      } catch (e) {
        resolve({ ok: false, error: { code: 'DISCONNECTED', message: String(e) } });
      }
    });
  }

  let lastResult = null;

  panel.setHandlers({
    rescore: () => score(true),
    openOptions: () => ask({ type: 'openOptions' }),
    copyDebug: (btn) => {
      if (!lastResult?.debug) return;
      copy(JSON.stringify(lastResult.debug, null, 2));
      flash(btn, 'Copied');
    },
    copyVacancy: (btn) => {
      if (!lastVacancy) return;
      copy(extract.toPlainText(lastVacancy));
      flash(btn, 'Copied');
    },
    copyForAi: async (btn) => {
      if (!lastVacancy) return;
      const profile = await ask({ type: 'getProfile' });
      copy(buildAiPrompt(lastVacancy, profile || {}));
      flash(btn, 'Copied');
    }
  });

  /**
   * hh renders the vacancy body asynchronously, so the description can still be
   * empty at document_idle. Wait for it briefly rather than extracting too early.
   */
  function whenReady(cb) {
    const deadline = Date.now() + 8000;
    (function poll() {
      const ready = document.querySelector('[data-qa="vacancy-description"]')
        && document.querySelector('[data-qa="vacancy-title"]');
      if (ready) return cb(true);
      if (Date.now() > deadline) return cb(false);
      setTimeout(poll, 250);
    })();
  }

  function onRoute() {
    const id = extract.isVacancyUrl(location.href)
      ? extract.vacancyIdFromUrl(location.href)
      : null;

    if (!id) {
      if (currentId) { panel.destroy(); currentId = null; }
      return;
    }
    if (id === currentId) return;      // same vacancy, nothing to do
    currentId = id;
    panel.destroy();                   // drop the previous vacancy's panel
    whenReady((ok) => { if (ok && currentId === id) score(false); });
  }

  // --- SPA navigation watcher ----------------------------------------------
  let lastHref = location.href;
  const check = () => {
    if (location.href !== lastHref) { lastHref = location.href; onRoute(); }
  };

  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function () { const r = orig.apply(this, arguments); check(); return r; };
  }
  window.addEventListener('popstate', check);

  // Fallback for in-page rendering that does not touch history. hh mutates the
  // DOM constantly, so coalesce bursts into one check per frame rather than
  // running on every mutation record.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; check(); });
  }).observe(document, { subtree: true, childList: true });

  onRoute();
})();
