import { expect, test } from "bun:test";

import {
  latestAssistantText,
  notificationPreview,
  shouldEmitBell,
  sanitizeNotificationText,
} from "./notify.ts";

test("notification previews use the first meaningful Markdown line", () => {
  expect(notificationPreview("# Finished\n\n- Updated the configuration.")).toBe("Finished");
  expect(notificationPreview("\n```text\nignored\n```\n\n**Done**")).toBe("Done");
});

test("notification previews are concise and cannot contain OSC controls", () => {
  const source = `Done;\x1b]777;notify;bad\x07 ${"x".repeat(200)}`;
  const preview = notificationPreview(source);

  expect(preview).not.toContain("\x1b");
  expect(preview).not.toContain("\x07");
  expect(preview).not.toContain(";");
  expect(preview.endsWith("…")).toBe(true);
  expect(preview.length).toBeLessThanOrEqual(180);
  expect(sanitizeNotificationText("a\nb\tc")).toBe("a b c");
});

test("extracts the latest assistant text from active session entries", () => {
  const entries = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Do work" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Planning" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Task completed." }],
      },
    },
  ];

  expect(latestAssistantText(entries)).toBe("Task completed.");
  expect(latestAssistantText([])).toBeUndefined();
});

test("emits BEL only in interactive TUI mode", () => {
  expect(shouldEmitBell("tui")).toBe(true);
  expect(shouldEmitBell("rpc")).toBe(false);
  expect(shouldEmitBell("json")).toBe(false);
  expect(shouldEmitBell("print")).toBe(false);
});
