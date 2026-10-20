import { Runtime } from "../utils/runtime.ts";
import { expect, test } from "vitest";

type PackageJson = {
  dependencies?: Record<string, string>;
};

test("react-doctor - package.json exposes the React version it uses", async () => {
  const packageJson: PackageJson = JSON.parse(
    await Runtime.readTextFile("package.json"),
  );

  expect(
    packageJson.dependencies?.react ?? "",
    "package.json must declare React 19 so react-doctor detects the runtime",
  ).toMatch(/^\^?19\./);
});
