import { assertMatch } from "@std/assert";

type PackageJson = {
  dependencies?: Record<string, string>;
};

Deno.test("react-doctor - package.json exposes the React version it uses", async () => {
  const packageJson: PackageJson = JSON.parse(
    await Deno.readTextFile("package.json"),
  );

  assertMatch(
    packageJson.dependencies?.react ?? "",
    /^\^?19\./,
    "package.json must declare React 19 so react-doctor detects the runtime",
  );
});
