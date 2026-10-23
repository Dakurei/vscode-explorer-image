const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const sent = [];
  const listeners = {};
  const elements = Object.fromEntries(['image', 'frame', 'placeholder'].map(id => [id, {
    hidden: id === 'image',
    attributes: {},
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return name === 'src' ? this.src : this.attributes[name]; },
    removeAttribute(name) { delete this[name]; delete this.attributes[name]; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
  }]));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/view.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }),
    document: { getElementById: id => elements[id] },
    window: { addEventListener: (type, callback) => { listeners[type] = callback; } },
  });
  return { ...elements, sent, receive: data => listeners.message({ data }) };
}

test('acknowledges a stream frame after decoding and also acknowledges an unchanged JPEG', () => {
  const state = setup();
  state.receive({ type: 'image', frameId: 1, image: 'data:image/jpeg;base64,first' });
  assert.equal(state.sent.length, 1, 'only the ready message has been sent');
  state.image.complete = true;
  state.image.naturalWidth = 1;
  state.image.listeners.load();
  assert.equal(state.sent.at(-1).type, 'frameDisplayed');
  assert.equal(state.sent.at(-1).frameId, 1);
  assert.equal(state.image.hidden, false);
  assert.equal(state.placeholder.hidden, true);

  state.receive({ type: 'image', frameId: 2, image: state.image.src });
  assert.equal(state.sent.at(-1).frameId, 2, 'identical images must not stall the stream');
  state.receive({ type: 'error', message: 'Flux interrompu' });
  assert.equal(state.image.hidden, false, 'the last decoded frame stays visible after disconnection');
  assert.equal(state.frame.title, 'Flux interrompu');
  state.image.listeners.load();
  assert.equal(state.frame.title, 'Flux interrompu', 'a late decode must preserve the disconnection error');
  state.receive({ type: 'image', frameId: 3, image: 'last waiting frame' });
  state.image.listeners.load();
  assert.equal(state.frame.title, 'Flux interrompu', 'the final waiting frame must preserve the error too');
  state.receive({ type: 'loading' });
  state.receive({ type: 'image', frameId: 4, image: 'new connection' });
  state.image.listeners.load();
  assert.equal(state.frame.title, '');
});

test('acknowledges decode failures so a later frame can recover', () => {
  const state = setup();
  state.receive({ type: 'image', frameId: 3, image: 'broken' });
  state.image.listeners.error();
  assert.equal(state.sent.at(-1).frameId, 3);
  assert.equal(state.image.hidden, true);
  assert.match(state.placeholder.textContent, /décoder/);
});

test('clearing or restarting the view invalidates acknowledgements from an earlier request', () => {
  for (const type of ['loading', 'empty']) {
    const state = setup();
    state.receive({ type: 'image', frameId: 4, image: 'old' });
    state.receive({ type });
    state.image.listeners.load();
    assert.equal(state.sent.length, 1);
  }
});
