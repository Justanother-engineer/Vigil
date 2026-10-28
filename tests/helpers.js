'use strict';
// Shared vm harness: loads extension sources with stubbed browser APIs.
// Tests drive behavior through the sources' real functions/message handlers.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..');

function readSource(name) {
  return fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
}

// Loads clipboard.js in an isolated context. Returns { context, state }.
// state.sentMessages captures every runtime.sendMessage call.
// state.listeners captures document.addEventListener registrations.
// opts.onSendMessage(msg) controls stubbed background replies.
function loadClipboard(opts = {}) {
  const state = { clipboardText: '', writes: [], sentMessages: [], listeners: {}, createdNodes: [] };

  // Minimal DOM node stub: enough for the alert renderer's create/append/shadow/
  // dialog calls. querySelector caches per selector so listener assertions work.
  function makeNode(tagName) {
    const node = {
      tagName: String(tagName).toUpperCase(),
      id: '',
      textContent: '',
      innerHTML: '',
      children: [],
      parentNode: null,
      listeners: {},
      style: { cssText: '', setProperty() {}, removeProperty() {} },
      classList: {
        _set: new Set(),
        add(...names) { names.forEach((n) => this._set.add(n)); },
        remove(...names) { names.forEach((n) => this._set.delete(n)); },
        contains(name) { return this._set.has(name); },
      },
      _queries: new Map(),
      appendChild(child) { node.children.push(child); child.parentNode = node; return child; },
      removeChild(child) {
        const i = node.children.indexOf(child);
        if (i >= 0) node.children.splice(i, 1);
        child.parentNode = null;
      },
      remove() { if (node.parentNode) node.parentNode.removeChild(node); },
      addEventListener(type, fn) { (node.listeners[type] ??= []).push(fn); },
      setAttribute() {},
      querySelector(sel) {
        if (!node._queries.has(sel)) node._queries.set(sel, makeNode('div'));
        return node._queries.get(sel);
      },
      focus() {},
      showModal() { node.showModalCalled = true; },
      attachShadow(options) {
        node.shadowRoot = makeNode('#shadow');
        node.shadowRoot.mode = options.mode;
        return node.shadowRoot;
      },
    };
    state.createdNodes.push(node);
    return node;
  }

  const documentElement = makeNode('html');

  const sandbox = {
    navigator: {
      clipboard: {
        readText: async () => state.clipboardText,
        writeText: async (t) => { state.writes.push(t); state.clipboardText = t; },
      },
    },
    document: {
      hasFocus: () => true,
      body: null,
      documentElement,
      createElement: (tagName) => makeNode(tagName),
      getElementById: () => null,
      addEventListener: (type, fn) => { (state.listeners[type] ??= []).push(fn); },
    },
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        id: 'test',
        sendMessage: async (m) => {
          state.sentMessages.push(m);
          if (opts.onSendMessage) return opts.onSendMessage(m);
          return undefined;
        },
        onMessage: { addListener: () => {} },
      },
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    console: opts.console ?? console,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(readSource('clipboard.js'), context, { filename: 'clipboard.js' });
  return { context, state };
}

// Loads background.js in an isolated context. Returns { context, state }.
// state.handlers.onMessage is the captured runtime.onMessage listener.
// opts: { store (object backing chrome.storage.local), fetchImpl, tabsSent (array) }
function loadBackground(opts = {}) {
  const store = opts.store ?? {};
  const state = { handlers: {}, tabsSent: opts.tabsSent ?? [], store };
  const sandbox = {
    fetch: opts.fetchImpl ?? (async () => { throw new Error('fetch not stubbed'); }),
    chrome: {
      runtime: {
        getURL: (p) => p,
        onInstalled: { addListener: (fn) => { state.handlers.onInstalled = fn; } },
        onStartup: { addListener: (fn) => { state.handlers.onStartup = fn; } },
        onMessage: { addListener: (fn) => { state.handlers.onMessage = fn; } },
      },
      alarms: {
        create: () => {},
        onAlarm: { addListener: (fn) => { state.handlers.onAlarm = fn; } },
      },
      tabs: {
        sendMessage: async (tabId, msg) => { state.tabsSent.push({ tabId, msg }); },
      },
      storage: {
        local: {
          get: async (keys) => {
            if (keys === undefined) return { ...store };
            const arr = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(arr.filter((k) => k in store).map((k) => [k, store[k]]));
          },
          set: async (items) => { Object.assign(store, items); },
        },
        onChanged: { addListener: () => {} },
      },
    },
    setTimeout: () => 0,
    console: opts.console ?? console,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(readSource('background.js'), context, { filename: 'background.js' });
  return { context, state };
}

// Calls the background onMessage handler and resolves with the sendResponse payload.
async function sendBackgroundMessage(state, request, sender = { tab: { id: 7 } }) {
  let resolveResponse;
  const responded = new Promise((resolve) => { resolveResponse = resolve; });
  state.handlers.onMessage(request, sender, (payload) => resolveResponse(payload));
  return responded;
}

// Loads the shipped pattern.json (local fallback file) and compiles it with the
// same guard background.js uses. Returns { entries, regexes, skipped }.
function loadShippedPatterns() {
  const entries = JSON.parse(readSource('pattern.json'));
  const regexes = [];
  const skipped = [];
  for (const p of entries) {
    try {
      if (!p || typeof p.source !== 'string' || p.source.length > 1000) { skipped.push(p); continue; }
      if (p.flags !== undefined && (typeof p.flags !== 'string' || !/^[gimsuy]*$/.test(p.flags))) { skipped.push(p); continue; }
      regexes.push(new RegExp(p.source, p.flags || ''));
    } catch {
      skipped.push(p);
    }
  }
  return { entries, regexes, skipped };
}

module.exports = { loadClipboard, loadBackground, sendBackgroundMessage, loadShippedPatterns };
