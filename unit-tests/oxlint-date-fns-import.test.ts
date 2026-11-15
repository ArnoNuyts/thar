import { join } from "node:path";
import { expect, test } from "vitest";

import { Runtime } from "../utils/runtime.ts";

const repoRoot = join(import.meta.dirname, "..");
const oxlintBin = join(repoRoot, "node_modules", "oxlint", "bin", "oxlint");
const configPath = join(repoRoot, ".oxlintrc.json");

const lint = async (source: string) => {
  const dir = await Runtime.makeTempDir();
  try {
    const fixturePath = join(dir, "fixture.ts");
    await Runtime.writeTextFile(fixturePath, source);
    const result = await new Runtime.Command(process.execPath, {
      args: [oxlintBin, "--config", configPath, "--no-ignore", fixturePath],
      cwd: repoRoot,
    }).output();

    return {
      success: result.success,
      output: Buffer.concat([result.stdout, result.stderr]).toString("utf8"),
    };
  } finally {
    await Runtime.remove(dir, { recursive: true });
  }
};

test("no-restricted-imports - flags the date-fns barrels", async () => {
  const fixtures = [
    'import { addDays } from "date-fns";',
    'import { add } from "date-fns/fp";',
    'import { enUS } from "date-fns/locale";',
  ];

  for (const fixture of fixtures) {
    const { success, output } = await lint(`${fixture}\n`);

    expect(success).toBe(false);
    expect(output).toContain("eslint(no-restricted-imports)");
  }
});

test("no-restricted-imports - allows date-fns subpath imports", async () => {
  const fixtures = [
    'import { addDays } from "date-fns/addDays";\nexport const value = addDays;',
    'import { enUS } from "date-fns/locale/en-US";\nexport const value = enUS;',
  ];

  for (const fixture of fixtures) {
    const { success, output } = await lint(`${fixture}\n`);

    expect(output).not.toContain("no-restricted-imports");
    expect(success).toBe(true);
  }
});
