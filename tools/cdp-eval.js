/**
 * Evaluate an expression inside the running app's renderer over CDP.
 *
 * Development aid used to verify the UI actually rendered, rather than
 * assuming it did because the window opened.
 *
 * Usage: node tools/cdp-eval.js <expression-file> [debug-port]
 */

import fs from 'node:fs';

const [, , exprFile, portArg] = process.argv;
const port = portArg || '9222';

if (!exprFile) {
  console.error('usage: node tools/cdp-eval.js <expression-file> [port]');
  process.exit(1);
}

const expression = fs.readFileSync(exprFile, 'utf8');

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');

if (!page) {
  console.error('no page target found');
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true },
  }));
});

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;

  if (message.result.exceptionDetails) {
    console.error(JSON.stringify(message.result.exceptionDetails, null, 2));
    process.exit(1);
  }

  const { value } = message.result.result;
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  socket.close();
  process.exit(0);
});

socket.addEventListener('error', () => {
  console.error('websocket error');
  process.exit(1);
});
