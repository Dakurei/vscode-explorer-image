const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { parseImageUrl } = require('../out/imageClient');

function setup(download = async () => 'data:image/png;base64,aGVsbG8=') {
  const values = { url: 'https://example.com/image.png', username: 'alice', refreshInterval: 60 };
  const messages = [];
  const timers = new Map();
  const commands = new Map();
  const secrets = new Map();
  const requests = [];
  const callbacks = {};
  let provider;
  let timerId = 0;
  const disposable = () => ({ dispose() {} });
  const register = name => callback => { callbacks[name] = callback; return disposable(); };
  const view = {
    visible: true,
    webview: {
      options: {}, html: '', cspSource: 'https://webview.test',
      asWebviewUri: uri => String(uri),
      onDidReceiveMessage: register('message'),
      postMessage: message => { messages.push(message); return Promise.resolve(true); },
    },
    onDidChangeVisibility: register('visibility'),
    onDidDispose: register('disposeView'),
  };
  const context = {
    subscriptions: [], extensionUri: '/extension',
    secrets: {
      get: async key => secrets.get(key),
      store: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); },
      onDidChange: register('secret'),
    },
  };
  const vscode = {
    window: {
      registerWebviewViewProvider: (_id, value) => { provider = value; return disposable(); },
      showInputBox: async () => 'from-vault',
      showInformationMessage() {}, showErrorMessage() {},
    },
    commands: {
      registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); },
      executeCommand: async name => commands.get(name)?.(),
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback }),
      onDidChangeConfiguration: register('configuration'),
    },
    Uri: { joinPath: (...parts) => parts.join('/') },
  };
  const sandbox = {
    exports: {}, console, AbortController, Date, Error,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => {
      if (name === 'vscode') return vscode;
      if (name === './imageClient') return {
        parseImageUrl,
        fetchImage: options => { requests.push(options); return download(options); },
      };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out/extension.js'), 'utf8'), sandbox);
  sandbox.exports.activate(context);
  provider.resolveWebviewView(view);
  return { values, messages, timers, commands, secrets, requests, callbacks, view, provider, context };
}

test('loads the configured image and schedules the default 60-second refresh', async () => {
  const state = setup();
  await state.provider.refresh();
  assert.equal(state.requests.length, 1);
  assert.equal(state.messages.find(message => message.type === 'image').image, 'data:image/png;base64,aGVsbG8=');
  assert.equal([...state.timers.values()][0].delay, 60_000);
  assert.ok(state.messages.find(message => message.type === 'schedule').nextRefreshAt > Date.now());
  state.provider.dispose();
  assert.equal(state.timers.size, 0);
});

test('zero interval keeps manual refresh and disables the timer', async () => {
  const state = setup();
  state.values.refreshInterval = 0;
  await state.commands.get('explorerImage.refresh')();
  assert.equal(state.requests.length, 1);
  assert.equal(state.timers.size, 0);
  assert.equal(state.messages.at(-1).nextRefreshAt, null);
  state.provider.dispose();
});

test('unchecking automatic refresh cancels the timer, preserves the interval and allows manual refresh', async () => {
  const state = setup();
  state.values.refreshInterval = 120;
  await state.provider.refresh();
  assert.equal([...state.timers.values()][0].delay, 120_000);

  state.values.autoRefresh = false;
  state.callbacks.configuration({ affectsConfiguration: () => true });
  await new Promise(setImmediate);
  assert.equal(state.timers.size, 0);
  assert.equal(state.messages.at(-1).nextRefreshAt, null);
  await state.commands.get('explorerImage.refresh')();
  assert.equal(state.requests.length, 3);
  assert.equal(state.timers.size, 0);
  assert.equal(state.values.refreshInterval, 120);

  state.values.autoRefresh = true;
  state.callbacks.configuration({ affectsConfiguration: () => true });
  await new Promise(setImmediate);
  assert.equal([...state.timers.values()][0].delay, 120_000);
  state.provider.dispose();
});

test('hiding the view aborts the request and prevents late images and timers', async () => {
  let finish;
  const state = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = state.provider.refresh();
  await new Promise(setImmediate);
  state.view.visible = false;
  state.callbacks.visibility();
  assert.equal(state.requests[0].signal.aborted, true);
  finish('data:image/png;base64,c3RhbGU=');
  await pending;
  assert.equal(state.messages.some(message => message.type === 'image'), false);
  assert.equal(state.timers.size, 0);
  await state.provider.refresh();
  assert.equal(state.requests.length, 1);
  state.provider.dispose();
});

test('clearing the URL clears the view and stops automatic refresh', async () => {
  const state = setup();
  await state.provider.refresh();
  state.values.url = '';
  await state.provider.refresh();
  assert.equal(state.messages.at(-1).type, 'empty');
  assert.equal(state.timers.size, 0);
  assert.equal(state.requests.length, 1);
  state.provider.dispose();
});

test('a failed download reports an error and still schedules another attempt', async () => {
  const state = setup(async () => { throw new Error('HTTP 503'); });
  await state.provider.refresh();
  assert.equal(state.messages.find(message => message.type === 'error').message, 'HTTP 503');
  assert.equal(state.timers.size, 1);
  state.provider.dispose();
});

test('vault passwords override settings and never enter the webview', async () => {
  const state = setup();
  state.values.password = 'from-settings';
  await state.commands.get('explorerImage.setPassword')();
  await state.provider.refresh();
  assert.equal(state.requests[0].password, 'from-vault');
  assert.doesNotMatch(JSON.stringify(state.messages) + state.view.webview.html, /from-vault|from-settings/);
  // A different origin must not reuse this secret.
  state.values.url = 'https://another.example.com/image.png';
  await state.provider.refresh();
  assert.equal(state.requests[1].password, 'from-settings');
  state.values.url = 'https://example.com/another-image.png';
  await state.commands.get('explorerImage.clearPassword')();
  assert.equal(state.secrets.size, 0);
  state.provider.dispose();
});

test('a newer refresh cancels the previous download and ignores its result', async () => {
  const finishes = [];
  const state = setup(() => new Promise(resolve => finishes.push(resolve)));
  const first = state.provider.refresh();
  await new Promise(setImmediate);
  state.values.url = 'https://example.com/new.png';
  const second = state.provider.refresh();
  await new Promise(setImmediate);
  assert.equal(state.requests[0].signal.aborted, true);
  finishes[1]('data:image/png;base64,bmV3');
  await second;
  finishes[0]('data:image/png;base64,b2xk');
  await first;
  const images = state.messages.filter(message => message.type === 'image');
  assert.equal(images.length, 1);
  assert.equal(images[0].image, 'data:image/png;base64,bmV3');
  assert.equal(state.timers.size, 1);
  state.provider.dispose();
});

test('a live stream keeps its connection, drops waiting frames and stops delivery when hidden', async () => {
  const state = setup(options => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const pending = state.provider.refresh();
  await new Promise(setImmediate);
  const images = () => state.messages.filter(message => message.type === 'image');
  const { onFrame, signal } = state.requests[0];
  onFrame('first');
  const first = images()[0];
  onFrame('second');
  onFrame('latest');
  assert.equal(images().length, 1, 'only one frame may be decoding in the webview');
  assert.equal(state.timers.size, 0, 'a live stream must not be restarted by the refresh timer');

  state.callbacks.message({ type: 'frameDisplayed', frameId: first.frameId });
  assert.deepEqual(images().map(message => message.image), ['first', 'latest']);
  onFrame('waiting');
  state.callbacks.message({ type: 'frameDisplayed', frameId: first.frameId });
  assert.equal(images().length, 2, 'an old acknowledgement must not release another frame');

  state.view.visible = false;
  state.callbacks.visibility();
  await pending;
  assert.equal(signal.aborted, true);
  onFrame('too late');
  state.callbacks.message({ type: 'frameDisplayed', frameId: images()[1].frameId });
  assert.equal(images().length, 2);
  assert.equal(state.timers.size, 0);

  state.view.visible = true;
  const reopened = state.provider.refresh();
  await new Promise(setImmediate);
  state.requests[1].onFrame('reopened');
  assert.equal(images().at(-1).image, 'reopened');
  state.provider.dispose();
  await reopened;
});

for (const [autoRefresh, refreshInterval, retry] of [[true, 5, true], [false, 5, false], [true, 0, false]]) {
  test(`stream disconnection respects autoRefresh=${autoRefresh}, interval=${refreshInterval} and allows manual reconnect`, async () => {
    const state = setup(async options => {
      options.onFrame('last JPEG');
      throw new Error('Le flux MJPEG est interrompu.');
    });
    state.values.autoRefresh = autoRefresh;
    state.values.refreshInterval = refreshInterval;
    await state.provider.refresh();
    assert.equal(state.messages.find(message => message.type === 'image').image, 'last JPEG');
    assert.equal(state.messages.find(message => message.type === 'error').message, 'Le flux MJPEG est interrompu.');
    assert.equal(state.timers.size, retry ? 1 : 0);
    if (retry) {
      const timer = [...state.timers.values()][0];
      assert.equal(timer.delay, 5_000);
      timer.callback();
      await new Promise(setImmediate);
      assert.equal(state.requests.length, 2);
    }
    const count = state.requests.length;
    await state.commands.get('explorerImage.refresh')();
    assert.equal(state.requests.length, count + 1);
    state.provider.dispose();
  });
}
