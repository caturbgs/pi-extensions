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

test("cleanup waits for queued writes and removes the session and matching shared backups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-plan-backup-cleanup-"));
  dirs.push(dir);
  const backup = new PlanBackup(dir);
  backup.enqueue(
    { sessionId: "session-a", cwd: "/project", state: state("Approved plan") },
    () => {},
  );
  await backup.clearSession("session-a", "Approved plan", "/project");

  expect(await backup.recover("session-a", "/project")).toBeUndefined();
  await expect(readFile(join(dir, "PLAN.md"), "utf8")).rejects.toThrow();
  await expect(readFile(join(dir, "state", "session-a", "PLAN.md"), "utf8")).rejects.toThrow();
  await expect(
    readFile(join(dir, "state", "session-a", "recovery.json"), "utf8"),
  ).rejects.toThrow();
});

test("cleanup preserves a shared plan that belongs to a different session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-plan-backup-preserve-"));
  dirs.push(dir);
  const backup = new PlanBackup(dir);
  backup.enqueue(
    {
      sessionId: "session-a",
      cwd: "/project-a",
      state: state("Other session plan"),
    },
    () => {},
  );
  await backup.flush();

  await backup.clearSession("session-a", "Approved plan", "/project-a");

  expect(await readFile(join(dir, "PLAN.md"), "utf8")).toBe("Other session plan\n");
  expect(await backup.recover("session-a", "/project-a")).toBeUndefined();
});

test("cleanup keeps the plan file when it is also the current-directory export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-plan-backup-export-"));
  dirs.push(dir);
  const backup = new PlanBackup(dir);
  backup.enqueue({ sessionId: "session-a", cwd: dir, state: state("Exported plan") }, () => {});
  await backup.flush();

  await backup.clearSession("session-a", "Exported plan", dir);

  expect(await readFile(join(dir, "PLAN.md"), "utf8")).toBe("Exported plan\n");
  expect(await backup.recover("session-a", dir)).toBeUndefined();
  await expect(readFile(join(dir, "state", "session-a", "PLAN.md"), "utf8")).rejects.toThrow();
});
