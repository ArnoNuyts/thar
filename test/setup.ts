import { test } from "vitest";
import { Runtime } from "../utils/runtime.ts";

type DenoTestContext = {
  step: (name: string, fn: () => void | Promise<void>) => Promise<void>;
};

type DenoTestBody = (context: DenoTestContext) => void | Promise<void>;

type DenoTestOptions = {
  name?: string;
  fn?: DenoTestBody;
  sanitizeOps?: boolean;
  sanitizeResources?: boolean;
  ignore?: boolean;
  only?: boolean;
  timeout?: number;
};

type DenoTestDefinition = DenoTestOptions & {
  name: string;
  fn: DenoTestBody;
};

type DenoTestFunction = {
  (name: string, fn: DenoTestBody): unknown;
  (name: string, options: DenoTestOptions, fn: DenoTestBody): unknown;
  (definition: DenoTestDefinition): unknown;
  (definition: DenoTestOptions, fn: DenoTestBody): unknown;
};

const testContext: DenoTestContext = {
  step: async (_name, fn) => {
    await fn();
  },
};

function wrapTestBody(fn: DenoTestBody) {
  return () => fn(testContext);
}

function denoTest(
  nameOrDefinition: string | DenoTestDefinition,
  optionsOrFn?: DenoTestOptions | DenoTestBody,
  maybeFn?: DenoTestBody,
): unknown {
  let name: string;
  let options: DenoTestOptions = {};
  let fn: DenoTestBody;

  if (typeof nameOrDefinition === "string") {
    name = nameOrDefinition;
    if (typeof optionsOrFn === "function") {
      fn = optionsOrFn;
    } else {
      options = optionsOrFn ?? {};
      if (!maybeFn) throw new Error(`Test "${name}" is missing a body`);
      fn = maybeFn;
    }
  } else {
    name = nameOrDefinition.name;
    options = nameOrDefinition;
    fn = typeof optionsOrFn === "function" ? optionsOrFn : nameOrDefinition.fn;
    if (!fn) throw new Error(`Test "${name}" is missing a body`);
  }

  if (options.ignore) return test.skip(name, wrapTestBody(fn));
  if (options.only) return test.only(name, wrapTestBody(fn));
  if (options.timeout) {
    return test(name, { timeout: options.timeout }, wrapTestBody(fn));
  }
  return test(name, wrapTestBody(fn));
}

const deno = Object.assign(Runtime, {
  test: denoTest as DenoTestFunction,
});

Object.defineProperty(globalThis, "Deno", {
  configurable: true,
  value: deno,
  writable: true,
});
