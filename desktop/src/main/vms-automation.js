/**
 * VMS Automation — drives the marketplace login and Feed ID connection.
 *
 * Selectors come from vms-selectors.js, which documents the verified DOM
 * contract of the deployed VMS build. Progress is driven by polling page state
 * (is the form mounted, has it unmounted, has the AWB field appeared) with
 * short settle delays, rather than by fixed timers alone.
 *
 * The automation only ever types into the login and Feed ID fields and clicks
 * the matching buttons. It never touches the camera, the recorder, the AWB
 * field, or the upload pipeline.
 */

const { getSelectors } = require('./vms-selectors');

const DEFAULT_POLL_INTERVAL_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an async predicate until it returns true or the timeout elapses.
 */
async function waitFor(predicate, timeoutMs = 15000, intervalMs = DEFAULT_POLL_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      // The page may be mid-navigation; retry until the deadline.
    }
    await sleep(intervalMs);
  }
  return false;
}

function exec(webContents, code) {
  if (!webContents || webContents.isDestroyed()) {
    return Promise.reject(new Error('VMS view is gone'));
  }
  return webContents.executeJavaScript(code, true);
}

/**
 * Set the value of a React-controlled input so that React's onChange fires.
 *
 * Assigning to .value directly is swallowed by React's synthetic event system,
 * so the native property setter is invoked and an input event is dispatched.
 * Returns a snippet, not a result; callers embed it.
 */
function reactSetValueSnippet(selectorJson, valueJson) {
  return `(() => {
    const el = document.querySelector(${selectorJson});
    if (!el) return false;
    const proto = el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, ${valueJson});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

/**
 * Click the button whose trimmed label equals the given text.
 */
function clickButtonByLabelSnippet(labelJson) {
  return `(() => {
    const label = ${labelJson};
    const buttons = Array.from(document.querySelectorAll('button'));
    const match = buttons.find((b) => {
      if (b.disabled) return false;
      return (b.textContent || '').trim().toLowerCase() === label.toLowerCase();
    });
    if (!match) return false;
    match.click();
    return true;
  })()`;
}

/**
 * Log in to the VMS.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function autoLogin(webContents, marketplace, creds, onProgress) {
  const report = (message, state) => {
    console.log(`[vms-automation] ${message}`);
    if (onProgress) onProgress(message, state);
  };

  const selectors = getSelectors(marketplace);
  if (!selectors || !selectors.verified) {
    report(`${marketplace} automation is not verified yet — please log in manually.`, 'manual');
    return { ok: false, reason: 'not_verified' };
  }

  if (!creds.username || !creds.password) {
    report('No saved credentials for this marketplace — please log in manually.', 'manual');
    return { ok: false, reason: 'no_credentials' };
  }

  const { login, feed, operator } = selectors;

  // An existing session may already be authenticated, in which case the login
  // form is never rendered and this whole step must be skipped.
  const alreadyAuthenticated = await exec(webContents, `(() => {
    const hasLogin = !!document.querySelector(${JSON.stringify(login.passwordSelector)});
    const hasFeed = !!document.querySelector(${JSON.stringify(feed.inputSelector)});
    const hasAwb = !!document.querySelector(${JSON.stringify(operator.awbInputSelector)});
    return !hasLogin && (hasFeed || hasAwb);
  })()`).catch(() => false);

  if (alreadyAuthenticated) {
    report('Existing VMS session restored — login not required.', 'ok');
    return { ok: true, reason: 'session_restored' };
  }

  report('Waiting for the VMS login form...');
  const formReady = await waitFor(() => exec(webContents, `(() => {
    return !!document.querySelector(${JSON.stringify(login.usernameSelector)})
        && !!document.querySelector(${JSON.stringify(login.passwordSelector)});
  })()`), 25000);

  if (!formReady) {
    report('Login form did not appear — please log in manually.', 'manual');
    return { ok: false, reason: 'form_not_found' };
  }

  report('Entering credentials...');
  const filledUser = await exec(
    webContents,
    reactSetValueSnippet(JSON.stringify(login.usernameSelector), JSON.stringify(creds.username))
  );
  const filledPass = await exec(
    webContents,
    reactSetValueSnippet(JSON.stringify(login.passwordSelector), JSON.stringify(creds.password))
  );

  if (!filledUser || !filledPass) {
    report('Could not fill the login fields — please log in manually.', 'manual');
    return { ok: false, reason: 'fill_failed' };
  }

  // Let the form's validation and controlled state settle before submitting.
  await sleep(1500);

  report('Submitting login...');
  const submitted = await exec(webContents, `(() => {
    const button = document.querySelector(${JSON.stringify(login.submitSelector)});
    if (button && !button.disabled) { button.click(); return true; }
    return ${clickButtonByLabelSnippet(JSON.stringify('Login'))};
  })()`);

  if (!submitted) {
    report('Could not find the Login button — please log in manually.', 'manual');
    return { ok: false, reason: 'submit_not_found' };
  }

  report('Waiting for authentication...');

  // Success is the login form unmounting and a post-login surface appearing.
  // Failure is the VMS rendering its "Login Failed" message with the form
  // still mounted, which must not be mistaken for a slow success.
  let failureMessage = null;

  const authenticated = await waitFor(async () => {
    const state = await exec(webContents, `(() => {
      const hasPassword = !!document.querySelector(${JSON.stringify(login.passwordSelector)});
      const hasFeed = !!document.querySelector(${JSON.stringify(feed.inputSelector)});
      const hasAwb = !!document.querySelector(${JSON.stringify(operator.awbInputSelector)});
      const text = document.body ? document.body.innerText : '';
      const failedAt = text.indexOf(${JSON.stringify(login.failureText)});
      return {
        hasPassword,
        hasFeed,
        hasAwb,
        failure: failedAt === -1 ? null : text.slice(failedAt, failedAt + 160).split('\\n')[0],
      };
    })()`);

    if (state.hasPassword && state.failure) {
      failureMessage = state.failure;
      return true;
    }
    return !state.hasPassword && (state.hasFeed || state.hasAwb);
  }, 30000);

  if (failureMessage) {
    report(`VMS rejected the login: ${failureMessage}`, 'error');
    return { ok: false, reason: 'rejected', detail: failureMessage };
  }

  if (!authenticated) {
    report('Login did not complete in time — please check the VMS and log in manually.', 'manual');
    return { ok: false, reason: 'timeout' };
  }

  report('Authenticated.', 'ok');
  return { ok: true };
}

/**
 * Fill the Feed ID and press Connect.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function connectFeed(webContents, marketplace, feedId, onProgress) {
  const report = (message, state) => {
    console.log(`[vms-automation] ${message}`);
    if (onProgress) onProgress(message, state);
  };

  const selectors = getSelectors(marketplace);
  if (!selectors || !selectors.verified) {
    return { ok: false, reason: 'not_verified' };
  }

  const { feed, operator } = selectors;

  if (!feedId) {
    report('No Feed ID configured — enter it in the VMS manually.', 'manual');
    return { ok: false, reason: 'no_feed_id' };
  }

  report('Waiting for the Feed ID field...');

  // The operator screen may already be up if the feed survived from a previous
  // session, in which case there is nothing to connect.
  const state = await waitFor(async () => {
    const found = await exec(webContents, `(() => ({
      feed: !!document.querySelector(${JSON.stringify(feed.inputSelector)}),
      awb: !!document.querySelector(${JSON.stringify(operator.awbInputSelector)}),
    }))()`);
    return found.feed || found.awb;
  }, 30000);

  if (!state) {
    report('Feed ID field did not appear — connect the feed manually.', 'manual');
    return { ok: false, reason: 'field_not_found' };
  }

  const alreadyConnected = await exec(
    webContents,
    `!!document.querySelector(${JSON.stringify(operator.awbInputSelector)})`
  );

  if (alreadyConnected) {
    report('Feed already connected — scan area is ready.', 'ok');
    return { ok: true, reason: 'already_connected' };
  }

  report('Entering Feed ID...');
  const filled = await exec(
    webContents,
    reactSetValueSnippet(JSON.stringify(feed.inputSelector), JSON.stringify(feedId))
  );

  if (!filled) {
    report('Could not fill the Feed ID — connect the feed manually.', 'manual');
    return { ok: false, reason: 'fill_failed' };
  }

  await sleep(1500);

  report('Connecting feed...');
  const clicked = await exec(webContents, clickButtonByLabelSnippet(JSON.stringify(feed.buttonLabel)));

  if (!clicked) {
    report('Could not find the Connect button — connect the feed manually.', 'manual');
    return { ok: false, reason: 'button_not_found' };
  }

  // The operator scan field appearing is the VMS's own confirmation that the
  // feed is attached and the camera surface is mounted.
  report('Waiting for the feed to attach...');
  const ready = await waitFor(
    () => exec(webContents, `!!document.querySelector(${JSON.stringify(operator.awbInputSelector)})`),
    30000
  );

  if (!ready) {
    report('Feed did not attach in time — check the Feed ID in the VMS.', 'manual');
    return { ok: false, reason: 'not_attached' };
  }

  report('Feed connected — ready to scan.', 'ok');
  return { ok: true };
}

/**
 * Report which VMS surface is currently on screen.
 * Used to detect expired sessions and feed disconnection.
 */
async function detectState(webContents, marketplace) {
  const selectors = getSelectors(marketplace);
  if (!selectors || !selectors.verified) return 'unknown';

  const { login, feed, operator } = selectors;

  try {
    return await exec(webContents, `(() => {
      if (document.querySelector(${JSON.stringify(operator.awbInputSelector)})) return 'scanning';
      if (document.querySelector(${JSON.stringify(feed.inputSelector)})) return 'feed';
      if (document.querySelector(${JSON.stringify(login.passwordSelector)})) return 'login';
      return 'unknown';
    })()`);
  } catch {
    return 'unknown';
  }
}

module.exports = {
  autoLogin,
  connectFeed,
  detectState,
  waitFor,
  sleep,
};
