import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeLoginForm } from './loginFlow.js';

class MockControl {
  value: string;

  constructor(value = '') {
    this.value = value;
  }
}

class MockForm extends EventTarget {
  private controls = new Map<string, MockControl>();
  reportValidityValue = true;

  elements = {
    namedItem: (name: string) => this.controls.get(name) ?? null,
  };

  setControl(name: string, value: string) {
    const control = this.controls.get(name);
    if (control) {
      control.value = value;
    } else {
      this.controls.set(name, new MockControl(value));
    }
  }

  reportValidity(): boolean {
    return this.reportValidityValue;
  }
}

test('initializeLoginForm routes valid submissions to finalizeOnboarding', () => {
  const mock = new MockForm();
  mock.setControl('loginEmail', ' user@example.com ');
  mock.setControl('loginPassword', '  super-secret  ');
  const form = mock as unknown as HTMLFormElement;

  let capturedLevel: string | null = null;
  let capturedDetails: Record<string, unknown> | null = null;

  initializeLoginForm(form, {
    finalizeOnboarding(level, details) {
      capturedLevel = level;
      capturedDetails = details;
    },
    membershipLevels: { MEMBER: 'member', DEMO: 'demo' },
  });

  const event = new Event('submit', { cancelable: true });
  const dispatchResult = form.dispatchEvent(event);

  assert.equal(dispatchResult, false, 'dispatch should report cancellation when default prevented');
  assert.equal(event.defaultPrevented, true, 'submit handler should prevent default');
  assert.equal(capturedLevel, 'member', 'member level should be forwarded to finalizeOnboarding');
  assert.deepEqual(capturedDetails, {
    email: 'user@example.com',
    name: 'user@example.com',
    plan: 'pro',
    password: '  super-secret  ',
  });
});

test('initializeLoginForm aborts when reportValidity fails', () => {
  const mock = new MockForm();
  mock.reportValidityValue = false;
  mock.setControl('loginEmail', 'demo@example.com');
  const form = mock as unknown as HTMLFormElement;

  let called = false;

  initializeLoginForm(form, {
    finalizeOnboarding() {
      called = true;
    },
    membershipLevels: { MEMBER: 'member' },
  });

  const event = new Event('submit', { cancelable: true });
  form.dispatchEvent(event);

  assert.equal(called, false, 'finalizeOnboarding should not run for invalid forms');
});

test('initializeLoginForm cleanup removes submit handler', () => {
  const mock = new MockForm();
  mock.setControl('loginEmail', 'cleanup@example.com');
  const form = mock as unknown as HTMLFormElement;

  let callCount = 0;

  const teardown = initializeLoginForm(form, {
    finalizeOnboarding() {
      callCount += 1;
    },
    membershipLevels: { MEMBER: 'member' },
  });

  form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(callCount, 1, 'handler should run before cleanup');

  teardown();
  form.dispatchEvent(new Event('submit', { cancelable: true }));

  assert.equal(callCount, 1, 'handler should not run after cleanup');
});
