(() => {
  const accounts = [...document.querySelectorAll('.account-row')].map((row) => ({
    label: row.querySelector('[data-role="label"]').value,
    marketplace: row.querySelector('[data-role="marketplace"]').value,
    code: row.querySelector('[data-role="code"]').value,
  }));

  return JSON.stringify({
    title: document.querySelector('h1').textContent,
    deviceId: document.getElementById('deviceId').value,
    steps: [...document.querySelectorAll('.step')].map((s) => s.querySelector('.step-label').textContent),
    activeStep: document.querySelector('.step.active .step-label').textContent,
    visiblePanel: document.querySelector('.step-panel:not([hidden]) h2').textContent,
    flipkartUrl: document.getElementById('fkUrl').value,
    backendUrl: document.getElementById('backendUrl').value,
    accountCount: accounts.length,
    accounts,
    notice: document.getElementById('notice').hidden ? null : document.getElementById('notice').textContent,
    bridge: typeof window.youthnic,
    nextVisible: !document.getElementById('btnNext').hidden,
    activateVisible: !document.getElementById('btnActivate').hidden,
  }, null, 2);
})()
