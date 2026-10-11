import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultSettings } from "./settings.ts";
import { READY_MARKER, type PlanAction, type PlanSettings } from "./types.ts";
let choices: (PlanAction | undefined)[] = [];
mock.module("./ui.ts", () => ({
	chooseAction: async () => choices.shift(),
	configureSettings: async () => {},
}));
const { createPlanMode } = await import("./index.ts");
const dirs: string[] = [];
const harnesses: ReturnType<typeof harness>[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.emit("session_shutdown", {});
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});
const plan =
	"# Proposed plan\n\n## Goal\nBuild the requested feature safely.\n\n1. Update source.\n2. Test behavior.";
function harness(dir: string, branch: any[] = []) {
	const events = new Map<string, Function>();
	const commands = new Map<string, any>();
	let tools = ["read", "bash", "write", "edit", "todo", "ask_user_question"];
	let thinking = "high";
	const model = { provider: "test", id: "model" };
	const messages: any[] = [],
		notifications: string[] = [],
		order: string[] = [];
	let compactFails = false,
		compactHeld = false,
		compactCallbacks: any;
	let newCalled = false,
		modelOK = true;
	let signalCompact!: () => void;
	const compactStarted = new Promise<void>((resolve) => {
		signalCompact = resolve;
	});
	const allEntries = [...branch];
	const pi: any = {
		on: (name: string, fn: Function) => events.set(name, fn),
		registerCommand: (name: string, command: any) =>
			commands.set(name, command),
		getActiveTools: () => [...tools],
		setActiveTools: (names: string[]) => {
			tools = [...names];
			order.push("tools");
		},
		getAllTools: () =>
			[
				...new Set([
					...tools,
					"read",
					"bash",
					"write",
					"edit",
					"todo",
					"ask_user_question",
					"codemode",
					"mcp_read",
					"mcp_write",
					"constructor",
				]),
			].map((name) => ({
				name,
				exposure: "direct",
				annotations: name === "mcp_read" ? { readOnlyHint: true } : undefined,
			})),
		getThinkingLevel: () => thinking,
		setThinkingLevel: (value: string) => {
			thinking = value;
			order.push(`thinking:${value}`);
		},
		setModel: async () => {
			order.push("model");
			return modelOK;
		},
		appendEntry: (customType: string, data: unknown) => {
			const entry = { type: "custom", customType, data };
			branch.push(entry);
			allEntries.push(entry);
		},
		sendUserMessage: (content: string, options: any) => {
			messages.push({ content, options });
			order.push("prompt");
		},
	};
	const ctx: any = {
		mode: "rpc",
		hasUI: true,
		cwd: dir,
		model,
		ui: {
			theme: { fg: (_: string, text: string) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message: string) => notifications.push(message),
			confirm: async () => true,
		},
		sessionManager: {
			getSessionId: () => "session-one",
			getSessionFile: () => "/session-one.jsonl",
			getBranch: () => branch,
			getEntries: () => allEntries,
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "test" && ["model", "implement"].includes(id)
					? { provider, id }
					: undefined,
			getApiKeyAndHeaders: async () =>
				modelOK ? { ok: true, apiKey: "key" } : { ok: false, error: "no auth" },
		},
		hasPendingMessages: () => false,
		isIdle: () => true,
		waitForIdle: async () => {},
		compact: (callbacks: any) => {
			order.push("compact");
			compactCallbacks = callbacks;
			signalCompact();
			if (!compactHeld)
				compactFails
					? callbacks.onError(new Error("compaction cancelled"))
					: callbacks.onComplete({});
		},
		newSession: async (options: any) => {
			newCalled = true;
			await events.get("session_shutdown")?.({ reason: "new" }, ctx);
			const newBranch: any[] = [];
			await options.setup({
				appendCustomEntry: (customType: string, data: unknown) =>
					newBranch.push({ type: "custom", customType, data }),
			});
			// Simulate a NEW runtime. Old pi/ctx would throw if used after this point.
			const destination = harness(join(dir, "fresh"), newBranch);
			createPlanMode(
				destination.pi as ExtensionAPI,
				dir,
				join(dir, "settings.json"),
			);
			await destination.emit("session_start", { reason: "new" });
			await options.withSession({
				...destination.ctx,
				sendUserMessage: async (content: string) =>
					destination.messages.push({ content }),
			});
			Object.assign(pi, {
				setModel: () => {
					throw new Error("stale pi used");
				},
				setThinkingLevel: () => {
					throw new Error("stale pi used");
				},
				setActiveTools: () => {
					throw new Error("stale pi used");
				},
			});
			return { cancelled: false };
		},
	};
	const h = {
		pi,
		ctx,
		branch,
		messages,
		notifications,
		order,
		compactStarted,
		events,
		commands,
		emit: async (name: string, event: any) => events.get(name)?.(event, ctx),
		command: async (args = "") => commands.get("plan").handler(args, ctx),
		get tools() {
			return tools;
		},
		get thinking() {
			return thinking;
		},
		get newCalled() {
			return newCalled;
		},
		set compactFails(value: boolean) {
			compactFails = value;
		},
		set compactHeld(value: boolean) {
			compactHeld = value;
		},
		set modelOK(value: boolean) {
			modelOK = value;
		},
		completeCompact: () => compactCallbacks.onComplete({}),
	};
	harnesses.push(h);
	return h;
}
async function setup(settings?: Partial<PlanSettings>, branch?: any[]) {
	const dir = await mkdtemp(join(tmpdir(), "pi-plan-workflow-"));
	dirs.push(dir);
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ ...defaultSettings(), ...settings }),
	);
	const h = harness(dir, branch);
	createPlanMode(h.pi as ExtensionAPI, dir, join(dir, "settings.json"));
	await h.emit("session_start", { reason: "startup" });
	return h;
}
async function complete(h: ReturnType<typeof harness>) {
	await h.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: `${plan}\n${READY_MARKER}` }],
		},
	});
}
test("only /plan is registered; defaults and nested calls are gated", async () => {
	const h = await setup();
	await h.command("Design a feature");
	expect([...h.commands.keys()]).toEqual(["plan"]);
	expect(h.tools).toContain("todo");
	expect(h.tools).toContain("ask_user_question");
	expect(h.tools).toContain("mcp_read");
	expect(h.tools).not.toContain("write");
	expect(h.tools).not.toContain("bash");
	expect(h.tools).not.toContain("mcp_write");
	expect(h.tools).not.toContain("constructor");
	expect(
		(
			await h.emit("tool_call", {
				toolName: "write",
				input: {},
				parentToolCallId: "codemode/1",
			})
		).block,
	).toBe(true);
	expect(
		await h.emit("tool_call", { toolName: "read", input: {} }),
	).toBeUndefined();
	expect(h.messages[0].content).toBe("Design a feature");
});
test("/plan argument autocomplete offers settings without matching prompt text", async () => {
	const h = await setup();
	const complete = h.commands.get("plan").getArgumentCompletions;
	for (const prefix of ["", "s", "set", "Settings"]) {
		expect(
			(await complete(prefix))?.map(({ value }: { value: string }) => value),
		).toEqual(["settings"]);
	}
	for (const prefix of ["Design a feature", "settings extra"]) {
		expect(await complete(prefix)).toBeNull();
	}
	expect([...h.commands.keys()]).toEqual(["plan"]);
});

test("enabled bash remains whitelisted", async () => {
	const h = await setup({ tools: { bash: true } });
	await h.command("Research");
	expect(
		await h.emit("tool_call", { toolName: "bash", input: { command: "ls" } }),
	).toBeUndefined();
	expect(
		(
			await h.emit("tool_call", {
				toolName: "bash",
				input: { command: "ls; rm x" },
			})
		).block,
	).toBe(true);
	expect(
		(await h.emit("user_bash", { command: "touch x" })).result.exitCode,
	).toBe(1);
});
test("thinking defaults inherit; planning override is restored for implementation", async () => {
	const h = await setup({ planningThinking: "low" });
	await h.command("Research");
	expect(h.thinking).toBe("low");
	await complete(h);
	choices = ["here"];
	await h.command();
	expect(h.thinking).toBe("high");
	expect(h.tools).toContain("write");
	expect(h.messages.at(-1).content).toContain(plan);
	expect(
		await h.emit("tool_call", { toolName: "write", input: {} }),
	).toBeUndefined();
});
test("approval is dispatched after settlement, never on aborted responses", async () => {
	const h = await setup();
	await h.command("Research");
	await complete(h);
	await h.emit("agent_settled", { aborted: true });
	expect(h.messages).toHaveLength(1);
	await h.emit("agent_settled", { aborted: false });
	expect(h.messages.at(-1)).toEqual({
		content: "/plan",
		options: { expandPromptTemplates: true },
	});
	await h.emit("agent_settled", { aborted: false });
	expect(h.messages).toHaveLength(2);
});
test("compact finishes before model/thinking/implementation; exact plan is re-inlined", async () => {
	const h = await setup({
		implementationModel: "test/implement",
		implementationThinking: "xhigh",
	});
	await h.command("Research");
	await complete(h);
	h.compactHeld = true;
	choices = ["compact"];
	const approval = h.command();
	await h.compactStarted;
	expect(h.order).toContain("compact");
	expect(h.messages).toHaveLength(1);
	h.completeCompact();
	await approval;
	expect(h.order.indexOf("compact")).toBeLessThan(h.order.indexOf("model"));
	expect(h.thinking).toBe("xhigh");
	expect(h.messages.at(-1).content).toContain(plan);
});
test("failed compaction or authentication never starts implementation", async () => {
	const h = await setup();
	await h.command("Research");
	await complete(h);
	h.compactFails = true;
	choices = ["compact"];
	await h.command();
	expect(h.messages).toHaveLength(1);
	expect(h.tools).not.toContain("write");
	h.compactFails = false;
	h.modelOK = false;
	choices = ["here"];
	await h.command();
	expect(h.messages).toHaveLength(1);
	expect(h.tools).not.toContain("write");
	expect(h.notifications.some((text) => text.includes("Authentication"))).toBe(
		true,
	);
});
test("revision returns to normal editor without prompting until user submits", async () => {
	const h = await setup();
	await h.command("Research");
	await complete(h);
	choices = ["revise"];
	await h.command();
	expect(h.messages).toHaveLength(1);
	const contract = await h.emit("before_agent_start", {
		prompt: "Change the scope",
	});
	expect(contract.message.content).toContain("complete replacement");
	expect(contract.message.content).toContain(plan);
	expect(h.tools).not.toContain("write");
});
test("export preserves planning state and writes exact markdown", async () => {
	const h = await setup();
	await h.command("Research");
	await complete(h);
	choices = ["export", undefined];
	await h.command();
	expect(await readFile(join(h.ctx.cwd, "PLAN.md"), "utf8")).toBe(`${plan}\n`);
	expect(h.tools).not.toContain("write");
	expect(h.messages).toHaveLength(1);
});
test("fresh implementation uses a new runtime and leaves source plan ready", async () => {
	const h = await setup({ implementationThinking: "xhigh" });
	await h.command("Research");
	await complete(h);
	choices = ["fresh"];
	await h.command();
	expect(h.newCalled).toBe(true);
	const destination = harnesses.at(-1)!;
	expect(destination.thinking).toBe("xhigh");
	expect(destination.messages.at(-1).content).toContain(plan);
	expect(destination.tools).toContain("write");
	expect(h.branch.at(-1).data.phase).toBe("ready");
});
test("context keeps only current planning contract, removes it after approval", async () => {
	const h = await setup();
	await h.command("Research");
	const entries = [
		{ role: "custom", customType: "plan-mode-contract", content: "old" },
		{ role: "user", content: "request" },
		{ role: "custom", customType: "plan-mode-contract", content: "current" },
	];
	expect((await h.emit("context", { messages: entries })).messages).toEqual(
		entries.slice(1),
	);
	await complete(h);
	choices = ["here"];
	await h.command();
	expect((await h.emit("context", { messages: entries })).messages).toEqual([
		entries[1],
	]);
});
test("branch-owned off state wins over a ready plan on another branch", async () => {
	const h = await setup();
	await h.command("Research");
	await complete(h);
	const ready = structuredClone(h.branch.at(-1));
	choices = ["here"];
	await h.command();
	expect(ready.data.phase).toBe("ready"); // Appended snapshots were not mutated.
	h.branch.splice(0, h.branch.length, ready);
	await h.emit("session_tree", {});
	expect(h.tools).not.toContain("write");
	h.branch.splice(0, h.branch.length);
	await h.emit("session_tree", {});
	expect(h.tools).toContain("write");
});

test("disk recovery requires a new complete assistant proposal before approval", async () => {
	const h = await setup();
	await h.command("Research");
	await complete(h);
	await h.emit("session_shutdown", { reason: "reload" });
	const restored = harness(h.ctx.cwd);
	createPlanMode(
		restored.pi as ExtensionAPI,
		h.ctx.cwd,
		join(h.ctx.cwd, "settings.json"),
	);
	await restored.emit("session_start", { reason: "reload" });
	expect(restored.branch.at(-1).data.phase).toBe("revising");
	expect(restored.tools).not.toContain("write");
	choices = ["here"];
	await restored.command();
	expect(restored.messages).toHaveLength(0);
	const contract = await restored.emit("before_agent_start", {});
	expect(contract.message.content).toContain(plan);
	await complete(restored);
	choices = ["here"];
	await restored.command();
	expect(restored.messages.at(-1).content).toContain(plan);
});

test("abandoned approval cannot run after runtime shutdown", async () => {
	const h = await setup();
	await h.command("Research");
	await complete(h);
	await h.emit("session_shutdown", { reason: "reload" });
	choices = ["here"];
	await h.command();
	expect(h.messages).toHaveLength(1);
	expect(h.tools).not.toContain("write");
});

test("queued corrections invalidate the old proposal until a new completion", async () => {
	const h = await setup();
	await h.command("Research");
	await complete(h);
	await h.emit("message_start", {
		message: { role: "user", content: "Change the design" },
	});
	await h.emit("message_start", {
		message: { role: "assistant", content: [] },
	});
	await h.emit("agent_settled", { aborted: false });
	expect(h.messages).toHaveLength(1);
	expect(h.branch.at(-1).data.phase).toBe("revising");
	await complete(h);
	await h.emit("agent_settled", { aborted: false });
	expect(h.messages.at(-1).content).toBe("/plan");
});

test("planning instructions survive automatic compaction without a new agent start", async () => {
	const h = await setup();
	await h.command("Research");
	const result = await h.emit("context", {
		messages: [{ role: "user", content: "compacted history" }],
	});
	expect(result.messages).toHaveLength(2);
	expect(result.messages.at(-1).customType).toBe("plan-mode-contract");
	expect(result.messages.at(-1).content).toContain(READY_MARKER);
});

test("reload cannot recover a disk plan from an abandoned branch", async () => {
	const h = await setup();
	await h.command("Research");
	await complete(h);
	// History retains the plan, but the active branch navigates before /plan.
	h.branch.splice(0, h.branch.length);
	await h.emit("session_start", { reason: "reload" });
	expect(h.tools).toContain("write");
	expect(h.branch).toHaveLength(0);
	expect(
		h.notifications.some((text) => text.includes("Recovered a plan backup")),
	).toBe(false);
});
