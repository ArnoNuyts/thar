import type { Runtime } from "../utils/runtime.ts";

declare global {
  namespace Deno {
    type FsEvent = import("../utils/runtime.ts").FsEvent;
    type FsWatcher = import("../utils/runtime.ts").FsWatcher;
    type WriteFileOptions = import("../utils/runtime.ts").WriteFileOptions;

    type TestContext = {
      step: (name: string, fn: () => void | Promise<void>) => Promise<void>;
    };
    type TestBody = (context: TestContext) => void | Promise<void>;
    type TestOptions = {
      name?: string;
      fn?: TestBody;
      sanitizeOps?: boolean;
      sanitizeResources?: boolean;
      ignore?: boolean;
      only?: boolean;
      timeout?: number;
    };
    type TestDefinition = TestOptions & {
      name: string;
      fn: TestBody;
    };
    type TestFunction = {
      (name: string, fn: TestBody): unknown;
      (name: string, options: TestOptions, fn: TestBody): unknown;
      (definition: TestDefinition): unknown;
      (definition: TestOptions, fn: TestBody): unknown;
    };

    const test: TestFunction;
    const readTextFile: typeof Runtime.readTextFile;
    const writeTextFile: typeof Runtime.writeTextFile;
    const stat: typeof Runtime.stat;
    const readDir: typeof Runtime.readDir;
    const mkdir: typeof Runtime.mkdir;
    const makeTempDir: typeof Runtime.makeTempDir;
    const remove: typeof Runtime.remove;
    const watchFs: typeof Runtime.watchFs;
    const unrefTimer: typeof Runtime.unrefTimer;
    const Command: typeof Runtime.Command;
    const errors: {
      IsADirectory: new (...args: never[]) => Error;
      NotFound: new (...args: never[]) => Error;
    };
  }
}

export {};
