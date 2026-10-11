import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PlanState } from "./types.ts";

export async function atomicWrite(
	file: string,
	content: string,
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, content, { mode: 0o600 });
		await rename(temp, file);
	} catch (error) {
		const { unlink } = await import("node:fs/promises");
		await unlink(temp).catch(() => {});
		throw error;
	}
}

export interface Backup {
	sessionId: string;
	cwd: string;
	state: PlanState;
}
export class PlanBackup {
	private pending = Promise.resolve();
	constructor(private directory: string) {}
	enqueue(backup: Backup, onError: (error: unknown) => void): void {
		// Capture bytes now so subsequent revisions cannot mutate a queued backup.
		const json = JSON.stringify(backup, null, 2);
		const markdown = backup.state.plan;
		const sessionDir = join(
			this.directory,
			"state",
			backup.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"),
		);
		this.pending = this.pending
			.then(async () => {
				if (markdown) {
					await atomicWrite(join(sessionDir, "PLAN.md"), `${markdown}\n`);
					await atomicWrite(join(this.directory, "PLAN.md"), `${markdown}\n`);
				}
				await atomicWrite(join(sessionDir, "recovery.json"), json);
			})
			.catch(onError);
	}
	async flush(): Promise<void> {
		await this.pending;
	}
	async recover(
		sessionId: string,
		cwd: string,
	): Promise<PlanState | undefined> {
		const file = join(
			this.directory,
			"state",
			sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"),
			"recovery.json",
		);
		try {
			const backup: Backup = JSON.parse(await readFile(file, "utf8"));
			if (
				backup.sessionId !== sessionId ||
				backup.cwd !== cwd ||
				backup.state?.version !== 1
			)
				return undefined;
			return backup.state;
		} catch {
			return undefined;
		}
	}
}
