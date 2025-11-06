declare module 'node:test' {
  type TestFunction = (name: string, fn: () => void | Promise<void>) => void;
  interface Test extends TestFunction {
    only: TestFunction;
    skip: TestFunction;
    todo: TestFunction;
  }
  const test: Test;
  export default test;
}

declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
