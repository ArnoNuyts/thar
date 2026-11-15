import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimePlatform = "windows" | "darwin" | "linux";

export type FsEventKind =
  | "any"
  | "access"
  | "create"
  | "modify"
  | "remove"
  | "rename"
  | "other";

export type FsEvent = {
  kind: FsEventKind;
  paths: string[];
  flag?: string;
};

export interface FsWatcher extends AsyncIterable<FsEvent> {
  close(): void;
}

export type WriteFileOptions = {
  append?: boolean;
  create?: boolean;
  /** Fail with EEXIST instead of overwriting an existing file. */
  exclusive?: boolean;
  mode?: number;
  signal?: AbortSignal;
};

export type CommandOptions = {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: "piped" | "inherit" | "null";
  stdout?: "piped" | "inherit" | "null";
  stderr?: "piped" | "inherit" | "null";
};

export type CommandOutput = {
  success: boolean;
  code: number;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

export type SpawnedCommand = {
  stdin: {
    getWriter(): {
      write(data: Uint8Array): Promise<void>;
      close(): Promise<void>;
    };
  };
  status: Promise<{ success: boolean; code: number }>;
};

const toPath = (path: string | URL) =>
  typeof path === "string" ? path : fileURLToPath(path);

const toStdio = (value: CommandOptions["stdin"]) => {
  if (value === "inherit") return "inherit";
  if (value === "null") return "ignore";
  return "pipe";
};

export class RuntimeCommand {
  readonly command: string;
  readonly options: CommandOptions;

  constructor(command: string, options: CommandOptions = {}) {
    this.command = command;
    this.options = options;
  }

  async output(): Promise<CommandOutput> {
    const child = spawn(this.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: [toStdio(this.options.stdin), "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const { code, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) =>
        resolve({ code: exitCode, signal: exitSignal }),
      );
    });

    return {
      success: code === 0,
      code: code ?? 1,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    };
  }

  async run(): Promise<{ success: boolean; code: number }> {
    const child = spawn(this.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: [
        toStdio(this.options.stdin),
        toStdio(this.options.stdout),
        toStdio(this.options.stderr),
      ],
    });

    return await new Promise<{ success: boolean; code: number }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          resolve({ success: code === 0, code: code ?? 1 }),
        );
      },
    );
  }

  spawn(): SpawnedCommand {
    const child = spawn(this.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: [
        toStdio(this.options.stdin),
        toStdio(this.options.stdout),
        toStdio(this.options.stderr),
      ],
    });

    if (!child.stdin) {
      throw new Error(
        `Command "${this.command}" was not spawned with piped stdin`,
      );
    }

    const stdin = child.stdin;
    stdin.on("error", () => {
      // The command may close stdin early; callers observe the exit status.
    });
    child.stdout?.resume();
    child.stderr?.resume();

    return {
      stdin: {
        getWriter() {
          return {
            async write(data: Uint8Array) {
              if (!stdin.write(data)) {
                await new Promise<void>((resolve) =>
                  stdin.once("drain", resolve),
                );
              }
            },
            async close() {
              stdin.end();
            },
          };
        },
      },
      status: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          resolve({ success: code === 0, code: code ?? 1 }),
        );
      }),
    };
  }
}

export function watchFs(filename: string): FsWatcher {
  const directory = dirname(filename);
  const target = basename(filename);
  const watcher = watch(directory, { persistent: true });
  const queue: FsEvent[] = [];
  const waiters: ((event: FsEvent | undefined) => void)[] = [];
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    watcher.close();
    while (waiters.length > 0) {
      waiters.shift()?.(undefined);
    }
  };

  const push = (event: FsEvent) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      queue.push(event);
    }
  };

  watcher.on("change", (eventType, changed) => {
    if (changed && String(changed) !== target) return;
    // Editors often replace a file atomically, which Node reports as
    // "rename" rather than "change". Treat both as content changes so the
    // reload path is not silently skipped.
    push({
      kind: eventType === "rename" ? "rename" : "modify",
      paths: [filename],
    });
  });
  watcher.on("error", close);

  return {
    close,
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const event =
          queue.shift() ??
          (await new Promise<FsEvent | undefined>((resolve) => {
            waiters.push(resolve);
          }));
        if (!event) return;
        yield event;
      }
    },
  };
}

/**
 * Test-only fault injection for the atomic replace.
 *
 * The data-safety suite has to prove that a failed write and a failed rename
 * leave the target untouched and no temp file behind. Neither error can be
 * provoked reliably through the real filesystem (a full disk, a rename that
 * fails after a successful write), so the replace path can be told to fail at a
 * named step. Production never sets it.
 *
 * @internal
 */
export type WriteFault = "write" | "rename";

let injectedWriteFault: WriteFault | undefined;

/** @internal */
export const setWriteFaultForTests = (fault: WriteFault | undefined): void => {
  injectedWriteFault = fault;
};

const faultError = (message: string, code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

/**
 * Stop the process between the temp-file flush and the rename.
 *
 * The crash test spawns a child process, writes through the real atomic
 * replace, and observes the target: it must hold either the old or the new
 * bytes, never a partial file. The hook only exists under a test runner
 * (`NODE_ENV=test`) and needs `THAR_WRITE_CRASH=before-rename`, so a normal run
 * cannot reach it.
 *
 * A crash at this point leaves the fully written temp file behind; the target is
 * untouched and the leftover name is never renamed into place, so the next save
 * simply writes a new temp file. Stale temp cleanup is deliberately not part of
 * the write path.
 */
const crashBeforeRename = (): void => {
  if (process.env.NODE_ENV !== "test") return;
  if (process.env.THAR_WRITE_CRASH !== "before-rename") return;
  process.exit(9);
};

/**
 * Flush the temp file before the rename so a crash cannot leave a target that
 * names unwritten bytes.
 *
 * Best effort on purpose: some platforms and filesystems do not support
 * `fsync` on a regular file, and a save must not fail because durability could
 * not be requested. The rename itself is still atomic; only the "survives a
 * power loss immediately after the rename" guarantee depends on this call.
 * Directory `fsync` (which would also persist the rename) is not done: it is not
 * portably available and it is deferred with the rest of the durability work.
 */
const flushBestEffort = async (handle: FileHandle): Promise<void> => {
  try {
    await handle.sync();
  } catch {
    // Documented above: the save proceeds without the extra flush.
  }
};

const writeTextFile = async (
  path: string | URL,
  data: string,
  options?: WriteFileOptions,
) => {
  const target = toPath(path);
  const append = options?.append === true;
  const mustExist = options?.create === false;
  const exclusive = options?.exclusive === true;

  if (exclusive) {
    await writeFile(target, data, {
      flag: "wx",
      mode: options?.mode,
      signal: options?.signal,
    });
    return;
  }

  if (append || mustExist) {
    await writeFile(target, data, {
      flag: append ? "a" : "r+",
      mode: options?.mode,
      signal: options?.signal,
    });
    return;
  }

  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );

  let mode = options?.mode;
  if (mode === undefined) {
    // Preserve the permissions of an existing file across the atomic replace.
    try {
      mode = (await stat(target)).mode & 0o777;
    } catch {
      mode = undefined;
    }
  }

  try {
    const handle = await open(temporary, "w", mode);
    try {
      if (injectedWriteFault === "write") {
        throw faultError("injected write failure", "ENOSPC");
      }
      await handle.writeFile(data);
      options?.signal?.throwIfAborted();
      await flushBestEffort(handle);
    } finally {
      await handle.close();
    }

    if (injectedWriteFault === "rename") {
      throw faultError("injected rename failure", "EIO");
    }
    crashBeforeRename();
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
};

export const Runtime = {
  platform: (process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux") as RuntimePlatform,
  args: process.argv.slice(2),
  cwd: process.cwd,
  exit: process.exit,
  consoleSize: () => ({
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  }),
  readTextFile: (path: string | URL) => readFile(toPath(path), "utf8"),
  writeTextFile,
  stat: async (path: string | URL) => {
    const info = await stat(toPath(path));
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymlink: info.isSymbolicLink(),
      size: info.size,
      mtime: info.mtime,
      atime: info.atime,
      birthtime: info.birthtime,
    };
  },
  readDir: async function* (path: string | URL) {
    const entries = await readdir(toPath(path), { withFileTypes: true });
    for (const entry of entries) {
      yield {
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      };
    }
  },
  mkdir: (path: string | URL, options?: { recursive?: boolean }) =>
    mkdir(toPath(path), { recursive: options?.recursive ?? false }),
  makeTempDir: () => mkdtemp(join(tmpdir(), "thar-")),
  rename: (from: string | URL, to: string | URL) =>
    rename(toPath(from), toPath(to)),
  remove: (path: string | URL, options?: { recursive?: boolean }) =>
    rm(toPath(path), { recursive: options?.recursive ?? false, force: false }),
  watchFs,
  unrefTimer: (timer: unknown) => {
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
  },
  Command: RuntimeCommand,
};

export type RuntimeApi = typeof Runtime;
