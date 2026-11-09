import { expect, test } from "bun:test";
import { parseTargets } from "../scripts/build";

test("release builds require explicit supported targets", () => {
  expect(parseTargets(["--target", "bun-linux-x64"])).toEqual(["bun-linux-x64"]);
  expect(parseTargets(["--all"])).toHaveLength(5);
  expect(() => parseTargets([])).toThrow();
  expect(() => parseTargets(["--target", "unknown"])).toThrow();
  expect(() => parseTargets(["--all", "extra"])).toThrow();
});
