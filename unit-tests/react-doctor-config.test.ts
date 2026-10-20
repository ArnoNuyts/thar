import { assertEquals } from "@std/assert";

type PackageJson = {
  dependencies?: Record<string, string>;
};

type DenoJson = {
  nodeModulesDir?: string;
  imports?: Record<string, string>;
};

Deno.test("react-doctor - package.json exposes the React version Deno resolves", async () => {
  const packageJson: PackageJson = JSON.parse(
    await Deno.readTextFile("package.json"),
  );
  const denoJson: DenoJson = JSON.parse(await Deno.readTextFile("deno.json"));

  const denoReactVersion = denoJson.imports?.["react"]?.replace(
    /^npm:react@/,
    "",
  );

  assertEquals(
    packageJson.dependencies?.react,
    denoReactVersion,
    "package.json must declare the same React version as deno.json so " +
      "react-doctor detects the runtime",
  );
  assertEquals(
    denoJson.nodeModulesDir,
    "none",
    "Deno must keep resolving dependencies from its cache now that a " +
      "package.json exists",
  );
});
