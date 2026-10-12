import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanBackup } from "./storage.ts";
import type { PlanState } from "./types.ts";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const state = (plan: string): PlanState => ({
  version: 1,
  phase: "ready",
  plan,
  originalTools: ["read", "write"],
  allowedTools: ["read"],
  originalThinking: "high",
});
test("backup is atomic, private, serialized, and scoped to a session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-plan-backup-"));
  dirs.push(dir);
  const backup = new PlanBackup(dir);
  const errors: unknown[] = [];
  const initial = state("First plan");
  backup.enqueue({ sessionId: "session-a", cwd: "/project", state: initial }, (error) =>
    errors.push(error),
  );
  initial.plan = "Changed after enqueue";
  backup.enqueue({ sessionId: "session-a", cwd: "/project", state: state("Final plan") }, (error) =>
    errors.push(error),
  );
  await backup.flush();
  expect(errors).toEqual([]);
  expect(await readFile(join(dir, "PLAN.md"), "utf8")).toBe("Final plan\n");
  expect((await stat(join(dir, "PLAN.md"))).mode & 0o777).toBe(0o600);
  expect((await backup.recover("session-a", "/project"))?.plan).toBe("Final plan");
  expect(await backup.recover("session-a", "/another-project")).toBeUndefined();
  expect(await backup.recover("session-b", "/project")).toBeUndefined();
});
