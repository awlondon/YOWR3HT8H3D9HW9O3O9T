import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordCommandUsage,
  getCommandUsageHistory,
  getCommandUsageCounts,
  registerCommandUsageSink,
  resetCommandUsageStateForTest,
} from './commandUsage.js';

test('recordCommandUsage normalizes commands, stores analytics, and updates global store', () => {
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = { CognitionEngine: {} } as any;
  try {
    resetCommandUsageStateForTest();

    recordCommandUsage({ command: '/Spin', membership: 'pro', args: ['alpha'] });
    recordCommandUsage({ command: 'omega', membership: 'enterprise', source: 'dispatch' });

    const history = getCommandUsageHistory();
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], {
      command: '/spin',
      membership: 'pro',
      args: ['alpha'],
      timestamp: history[0].timestamp,
      source: 'handler',
    });
    assert.deepEqual(history[1], {
      command: '/omega',
      membership: 'enterprise',
      args: [],
      timestamp: history[1].timestamp,
      source: 'dispatch',
    });

    const counts = getCommandUsageCounts();
    assert.equal(counts['/spin'], 1);
    assert.equal(counts['/omega'], 1);

    const store = ((globalThis as any).window.CognitionEngine as any).commandUsage;
    assert.equal(Array.isArray(store.history), true);
    assert.equal(store.history.length, 2);
    assert.equal(store.counts['/spin'], 1);
    assert.equal(store.last.command, '/omega');
  } finally {
    resetCommandUsageStateForTest();
    (globalThis as any).window = originalWindow;
  }
});

test('command usage sinks receive events and can unsubscribe', () => {
  resetCommandUsageStateForTest();
  const events: any[] = [];
  const unsubscribe = registerCommandUsageSink(event => {
    events.push(event);
  });

  recordCommandUsage({ command: '/alpha', membership: 'standard' });
  unsubscribe();
  recordCommandUsage({ command: '/beta', membership: 'standard' });

  assert.equal(events.length, 1);
  assert.equal(events[0].command, '/alpha');
});

test('command usage history is capped at 200 entries', () => {
  resetCommandUsageStateForTest();
  for (let i = 0; i < 205; i += 1) {
    recordCommandUsage({ command: `/cmd${i}`, membership: 'tier' });
  }
  const history = getCommandUsageHistory();
  assert.equal(history.length, 200);
  assert.equal(history[0].command, '/cmd5');
  assert.equal(history[history.length - 1].command, '/cmd204');
});
