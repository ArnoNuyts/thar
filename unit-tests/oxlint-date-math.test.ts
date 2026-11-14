import { join } from "node:path";
import { expect, test } from "vitest";

import { Runtime } from "../utils/runtime.ts";

const repoRoot = join(import.meta.dirname, "..");
const oxlintBin = join(repoRoot, "node_modules", "oxlint", "bin", "oxlint");
const pluginPath = join(repoRoot, "scripts", "oxlint-plugin.mjs");

const runOxlint = async (fixturePath: string, configPath: string) => {
  const result = await new Runtime.Command(process.execPath, {
    args: [oxlintBin, "--config", configPath, "--no-ignore", fixturePath],
    cwd: repoRoot,
  }).output();

  return {
    success: result.success,
    output: Buffer.concat([result.stdout, result.stderr]).toString("utf8"),
  };
};

test("no-native-date-math - flags native Date mutation and calendar arithmetic", async () => {
  const dir = await Runtime.makeTempDir();
  try {
    const configPath = join(dir, "oxlintrc.json");
    const fixturePath = join(dir, "fixture.ts");

    await Runtime.writeTextFile(
      configPath,
      JSON.stringify({
        jsPlugins: [pluginPath],
        rules: { "thar/no-native-date-math": "error" },
      }),
    );
    await Runtime.writeTextFile(
      fixturePath,
      [
        "const base = new Date();",
        "base.setDate(base.getDate() + 1);",
        "const nextMonth = base.getMonth() + 1;",
        "",
      ].join("\n"),
    );

    const { success, output } = await runOxlint(fixturePath, configPath);

    expect(success).toBe(false);
    expect(output).toContain("thar(no-native-date-math)");
    // `setDate`/`getDate` count once, and `getMonth` once.
    expect(output.match(/thar\(no-native-date-math\)/g)).toHaveLength(2);
    expect(output).toContain("`setDate()`");
    expect(output).toContain("`getMonth()`");
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
});

test("no-native-date-math - allows date-fns helpers and time-of-day math", async () => {
  const dir = await Runtime.makeTempDir();
  try {
    const configPath = join(dir, "oxlintrc.json");
    const fixturePath = join(dir, "fixture.ts");

    await Runtime.writeTextFile(
      configPath,
      JSON.stringify({
        jsPlugins: [pluginPath],
        rules: { "thar/no-native-date-math": "error" },
      }),
    );
    await Runtime.writeTextFile(
      fixturePath,
      [
        'import { addDays, addMonths, format } from "date-fns";',
        "",
        "const base = new Date();",
        "const tomorrow = addDays(base, 1);",
        "const nextMonth = addMonths(base, 1);",
        'const label = format(tomorrow, "yyyy-MM-dd");',
        'const labelMonth = format(nextMonth, "yyyy-MM");',
        "const hour = base.getHours() + 1;",
        "const elapsed = base.getTime() - Date.now();",
        "export { elapsed, hour, label, labelMonth };",
        "",
      ].join("\n"),
    );

    const { success, output } = await runOxlint(fixturePath, configPath);

    expect(output).not.toContain("thar(no-native-date-math)");
    expect(success).toBe(true);
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
});
