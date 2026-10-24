/**
 * Verified DOM contract for the Flipkart VMS (https://fkvms.synlabs.io/).
 *
 * Every selector below was read out of the deployed application bundle
 * (/assets/index.*.js), not inferred from screenshots. The VMS is a React +
 * Ant Design single-page app, so the relevant facts are:
 *
 *   Login screen (route /login)
 *     <Form className="login-form">
 *       <Form.Item name="email">   -> <input id="email" placeholder="Username">
 *       <Form.Item name="password">-> <input id="password" type="password" placeholder="Password">
 *       <Button htmlType="submit">Login</Button> -> <button type="submit">
 *     Failure surfaces as a "Login Failed:" message and the form stays mounted.
 *
 *   Feed connect screen (rendered while no feed is attached)
 *     Title "Connect to Feed", subtitle "Scan the Feed Id on your Desk!"
 *     <Input placeholder="Scan the Feed Id here..."> (no id attribute)
 *     <Button type="primary">Connect</Button>
 *
 *   Operator scan screen (rendered once a feed is attached)
 *     <Input id="awbInput" placeholder="AWB12345"> (placeholder is
 *     "Scan Flier Id..." in the RVP return flow)
 *     A "Disconnect" button is present alongside it.
 *
 * Scan commit behaviour, which the barcode observer deliberately mirrors:
 *   - AWB must match /^[a-zA-Z0-9_-]*$/ and be 4-30 characters.
 *   - The VMS commits a scan ~1000 ms after the input value settles; there is
 *     no Enter handler on the field.
 *   - After committing, the VMS calls awbInput.select(), so the previous AWB
 *     stays in the box (selected) until the next scan overwrites it.
 *
 * If Synlabs redeploys the VMS with a different build, re-verify this file
 * first; nothing else in the app hardcodes VMS selectors.
 */

const FLIPKART = {
  login: {
    formSelector: 'form.login-form',
    usernameSelector: '#email, input[placeholder="Username"]',
    passwordSelector: '#password, input[type="password"]',
    submitSelector: 'form.login-form button[type="submit"]',
    // Text the VMS renders when authentication is rejected.
    failureText: 'Login Failed',
  },
  feed: {
    inputSelector: 'input[placeholder="Scan the Feed Id here..."]',
    // The Connect button carries no stable id, so it is matched by label
    // among the buttons rendered on the feed screen.
    buttonLabel: 'Connect',
    headingText: 'Connect to Feed',
  },
  operator: {
    // Stable id, used by the VMS itself via getElementById("awbInput").
    awbInputSelector: '#awbInput',
    awbPattern: '^[a-zA-Z0-9_-]+$',
    awbMinLength: 4,
    awbMaxLength: 30,
    // The VMS waits this long after the value settles before committing.
    vmsCommitDelayMs: 1000,
  },
};

/**
 * Myntra is not yet verified. Its VMS URL, login screen and Feed ID flow must
 * be inspected with authorized access before automation is enabled, exactly as
 * was done for Flipkart. Until then the app loads the configured Myntra URL and
 * leaves login and feed connection to the operator.
 */
const MYNTRA = {
  verified: false,
  login: null,
  feed: null,
  operator: null,
};

const SELECTORS = {
  flipkart: { verified: true, ...FLIPKART },
  myntra: MYNTRA,
};

function getSelectors(marketplace) {
  return SELECTORS[marketplace] || null;
}

module.exports = { SELECTORS, getSelectors };
