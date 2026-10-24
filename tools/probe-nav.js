(async () => {
  const log = [];
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));

  const state = () => ({
    step: document.querySelector('.step.active .step-label').textContent,
    panel: document.querySelector('.step-panel:not([hidden]) h2').textContent,
    visiblePanels: document.querySelectorAll('.step-panel:not([hidden])').length,
  });

  const tick = () => new Promise((r) => setTimeout(r, 60));

  // Walk back to the first step, then forward through every step, so the
  // indicator and panel visibility are checked at each position.
  for (let i = 0; i < 8; i += 1) {
    document.getElementById('btnPrev').click();
    await tick();
  }
  log.push({ at: 'start', ...state(), prevDisabled: document.getElementById('btnPrev').disabled });

  for (let i = 0; i < 5; i += 1) {
    document.getElementById('btnNext').click();
    await tick();
    log.push({
      at: `next${i + 1}`,
      ...state(),
      notice: document.getElementById('notice').hidden ? null : document.getElementById('notice').textContent,
    });
  }

  log.push({
    at: 'final',
    nextHidden: document.getElementById('btnNext').hidden,
    activateHidden: document.getElementById('btnActivate').hidden,
    reviewRows: document.querySelectorAll('#review .review-row').length,
    reviewText: [...document.querySelectorAll('#review .review-row')]
      .map((r) => r.textContent).join(' | '),
  });

  return JSON.stringify({ log, errors }, null, 2);
})()
