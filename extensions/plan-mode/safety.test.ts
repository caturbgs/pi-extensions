import { describe, expect, test } from "bun:test";
import {
  checkBash,
  DEFAULT_BASH_WHITELIST,
  isDefaultToolEnabled,
  isWhitelistEntry,
} from "./safety.ts";

const safe = (command: string, whitelist = DEFAULT_BASH_WHITELIST) =>
  checkBash(command, whitelist).allowed;
describe("planning tools", () => {
  test("read-only and approved workflow defaults", () => {
    for (const name of ["read", "grep", "find", "ls", "todo", "ask_user_question"])
      expect(isDefaultToolEnabled({ name })).toBe(true);
    for (const name of ["bash", "write", "edit", "Agent", "codemode", "unknown"])
      expect(isDefaultToolEnabled({ name })).toBe(false);
    expect(
      isDefaultToolEnabled({
        name: "mcp_reader",
        annotations: { readOnlyHint: true },
      }),
    ).toBe(true);
  });
});
describe("bash whitelist", () => {
  test.each([
    "pwd",
    "ls -la",
    "cat 'file with spaces.md'",
    "rg 'some|pattern' src",
    "find src -name '*.ts'",
    "ls && cat README.md",
    "ls | head -n 5",
    "pwd\nls",
    "git --no-pager status",
    "git --no-pager diff --no-ext-diff --no-textconv",
  ])("allows %s", (command) => expect(safe(command)).toBe(true));
  test.each([
    "rm file",
    "ls; rm file",
    "ls && touch file",
    "ls | sh",
    "ls &",
    "ls > file",
    "cat < file",
    "cat $(touch a)",
    "cat `touch a`",
    "cat ${HOME}",
    "ls\\nrm x",
    "find . -delete",
    "find . -exec rm {} +",
    "find . -fprint result",
    "rg --pre=script foo",
    "file -C",
    "git --no-pager diff --no-ext-diff --no-textconv --output=result",
    "git --no-pager diff --no-ext-diff --textconv",
    "git --no-pager status --exec-path=evil",
    "git -c core.pager=evil status",
    "git --no-pager diff",
    "",
    "ls ||",
    "ls #comment",
    "'ls",
    "LS",
    "/bin/ls",
  ])("blocks %s", (command) => expect(safe(command)).toBe(false));
  test("custom literal prefixes only", () => {
    expect(isWhitelistEntry("bun --version")).toBe(true);
    expect(isWhitelistEntry("bun.*")).toBe(false);
    expect(isWhitelistEntry("bun; ls")).toBe(false);
    expect(safe("bun --version", ["bun --version"])).toBe(true);
    expect(safe("bun run test", ["bun --version"])).toBe(false);
    expect(safe("bun --version; rm file", ["bun --version"])).toBe(false);
  });
  test.each([
    "find . -de*",
    "find . -de?ete",
    "find . -[d]elete",
    "ls *",
    "file -Cm magic",
    "file -bC magic",
    "file --compile magic",
  ])("blocks option injection: %s", (command) => expect(safe(command)).toBe(false));
  test("quoted glob patterns remain literal and safe", () => {
    expect(safe("find src -name '*.ts'")).toBe(true);
    expect(safe("rg '[a-z]*' src")).toBe(true);
  });
});
