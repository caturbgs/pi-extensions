import { expect, test } from "bun:test";

import { baseTitle, statusTitle } from "./titlebar-spinner.ts";

test("uses the session name or directory as the base title", () => {
  expect(baseTitle("work", "/Users/example/dev-config")).toBe("π - work");
  expect(baseTitle(undefined, "/Users/example/dev-config")).toBe("π - dev-config");
});

test("formats agent states with the session name or directory", () => {
  const cwd = "/Users/example/dev-config";

  expect(statusTitle("working", "work", cwd, "⠋")).toBe("⠋ π - Working — work");
  expect(statusTitle("needs-input", "work", cwd)).toBe("π - Needs input — work");
  expect(statusTitle("finished", undefined, cwd)).toBe("π - Finished — dev-config");
});
