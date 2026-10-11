import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASH_WHITELIST } from "./safety.ts";
import { defaultSettings, loadSettings, saveSettings } from "./settings.ts";
import type { PlanSettings, ThinkingSetting } from "./types.ts";

let directory: string;
let file: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-plan-settings-test-"));
	file = join(directory, "settings.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("missing files use independent defaults and the shared bash whitelist", () => {
	const settings = loadSettings(file);
	expect(settings).toEqual({
		version: 1,
		tools: {},
		bashWhitelist: DEFAULT_BASH_WHITELIST,
		planningThinking: "inherit",
		implementationModel: "inherit",
		implementationThinking: "inherit",
	});
	settings.tools.read = false;
	settings.bashWhitelist.push("custom");
	expect(defaultSettings().tools).toEqual({});
	expect(defaultSettings().bashWhitelist).toEqual(DEFAULT_BASH_WHITELIST);
});

test("loads all thinking levels, tool overrides and model IDs containing slashes", () => {
	const levels: ThinkingSetting[] = [
		"inherit",
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	];
	for (const level of levels) {
		const settings = {
			...defaultSettings(),
			tools: { read: false, custom: true },
			planningThinking: level,
			implementationThinking: level,
			implementationModel: "openrouter/vendor/model",
		};
		writeFileSync(file, JSON.stringify(settings));
		expect(loadSettings(file)).toEqual(settings);
	}
});

test("rejects non-JSON syntax instead of silently replacing it with defaults", () => {
	for (const text of [
		"",
		"// comment\n{}",
		'{"version":1,}',
		"{",
		'{"version":NaN}',
	]) {
		writeFileSync(file, text);
		expect(() => loadSettings(file)).toThrow("Invalid plan settings");
	}
});

test("strictly rejects missing/extra fields, wrong types, invalid prefixes and invalid enums", () => {
	const defaults = defaultSettings();
	const invalid = [
		null,
		[],
		{},
		{ ...defaults, version: 2 },
		{ ...defaults, extra: true },
		{ ...defaults, tools: [] },
		{ ...defaults, tools: { read: "true" } },
		{ ...defaults, tools: { "": true } },
		{ ...defaults, tools: { " read ": true } },
		{ ...defaults, bashWhitelist: "pwd" },
		{ ...defaults, bashWhitelist: [null] },
		{ ...defaults, bashWhitelist: [""] },
		{ ...defaults, bashWhitelist: [" pwd"] },
		{ ...defaults, bashWhitelist: ["pwd\nls"] },
		{ ...defaults, bashWhitelist: ["pwd; ls"] },
		{ ...defaults, bashWhitelist: ["cat > file"] },
		{ ...defaults, bashWhitelist: ["cat $(pwd)"] },
		{ ...defaults, planningThinking: "auto" },
		{ ...defaults, implementationThinking: false },
		{ ...defaults, implementationModel: "model-only" },
		{ ...defaults, implementationModel: "/model" },
		{ ...defaults, implementationModel: "provider/" },
		{ ...defaults, implementationModel: "provider/model id" },
	];
	for (const value of invalid) {
		writeFileSync(file, JSON.stringify(value));
		expect(() => loadSettings(file)).toThrow("Invalid plan settings");
	}
});

test("filesystem errors other than ENOENT propagate", () => {
	mkdirSync(file);
	expect(() => loadSettings(file)).toThrow();
});

test("saves and replaces atomically with exact 0600 permissions and no temporary files", async () => {
	writeFileSync(file, "old settings");
	chmodSync(file, 0o644);
	const oldInode = statSync(file).ino;
	const settings = {
		...defaultSettings(),
		tools: { bash: true },
		bashWhitelist: [],
	};
	await saveSettings(file, settings);
	expect(loadSettings(file)).toEqual(settings);
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(statSync(file).ino).not.toBe(oldInode);
	expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
	expect(readdirSync(directory)).toEqual(["settings.json"]);
});

test("creates a missing parent directory", async () => {
	const nested = join(directory, "nested", "settings.json");
	await saveSettings(nested, defaultSettings());
	expect(loadSettings(nested)).toEqual(defaultSettings());
	expect(statSync(nested).mode & 0o777).toBe(0o600);
});

test("invalid saves leave an existing destination untouched", async () => {
	writeFileSync(file, "original");
	await expect(
		saveSettings(file, {
			...defaultSettings(),
			tools: { read: "yes" },
		} as unknown as PlanSettings),
	).rejects.toThrow();
	expect(readFileSync(file, "utf8")).toBe("original");
	expect(readdirSync(directory)).toEqual(["settings.json"]);
});

test("failed rename cleans up the private temporary file", async () => {
	mkdirSync(file);
	await expect(saveSettings(file, defaultSettings())).rejects.toThrow();
	expect(readdirSync(directory)).toEqual(["settings.json"]);
	expect(statSync(file).isDirectory()).toBe(true);
});

test("atomic saves update a symlink target without replacing the link", async () => {
	const targetDir = join(directory, "repo-config");
	mkdirSync(targetDir);
	const target = join(targetDir, "plan-mode-settings.json");
	writeFileSync(target, JSON.stringify(defaultSettings()));
	symlinkSync(target, file);
	const settings = { ...defaultSettings(), tools: { codemode: true } };
	await saveSettings(file, settings);
	expect(loadSettings(file)).toEqual(settings);
	expect(loadSettings(target)).toEqual(settings);
	expect(lstatSync(file).isSymbolicLink()).toBe(true);
});

test("concurrent writers leave one complete valid document", async () => {
	const first = { ...defaultSettings(), planningThinking: "high" as const };
	const second = {
		...defaultSettings(),
		implementationThinking: "max" as const,
	};
	await Promise.all([saveSettings(file, first), saveSettings(file, second)]);
	expect([first, second]).toContainEqual(loadSettings(file));
	expect(readdirSync(directory)).toEqual(["settings.json"]);
});
