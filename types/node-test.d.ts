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
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(block: () => unknown, error?: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:crypto' {
  export const webcrypto: Crypto;
}

declare class Buffer {
  static from(data: string, encoding?: string): Buffer;
  toString(encoding?: string): string;
}

declare module 'estree' {
  interface Node {
    type: string;
    [key: string]: unknown;
  }
  export type BaseNode = Node;
}

declare module 'json5' {
  const json5: any;
  export default json5;
}
