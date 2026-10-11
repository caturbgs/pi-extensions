import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DEFAULT_BASH_WHITELIST, isWhitelistEntry } from "./safety.ts";
import type { PlanSettings, ThinkingSetting } from "./types.ts";

const THINKING_SETTINGS: readonly ThinkingSetting[] = [
	"inherit",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const SETTINGS_KEYS = [
	"version",
	"tools",
	"bashWhitelist",
	"planningThinking",
	"implementationModel",
	"implementationThinking",
];

export function defaultSettings(): PlanSettings {
	return {
		version: 1,
		// An absent override uses isDefaultToolEnabled() for each registered tool.
		tools: {},
		bashWhitelist: [...DEFAULT_BASH_WHITELIST],
		planningThinking: "inherit",
		implementationModel: "inherit",
		implementationThinking: "inherit",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSingleLine(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject line and terminal controls in settings.
		!/[\x00-\x1f\x7f]/.test(value)
	);
}

function validateSettings(value: unknown): asserts value is PlanSettings {
	if (!isRecord(value)) throw new Error("Settings must be a JSON object");
	if (
		Object.keys(value).length !== SETTINGS_KEYS.length ||
		SETTINGS_KEYS.some((key) => !Object.hasOwn(value, key))
	) {
		throw new Error(
			`Settings must contain only these fields: ${SETTINGS_KEYS.join(", ")}`,
		);
	}
	if (value.version !== 1) throw new Error("Settings version must be 1");
	if (
		!isRecord(value.tools) ||
		Object.entries(value.tools).some(
			([name, enabled]) => !isSingleLine(name) || typeof enabled !== "boolean",
		)
	) {
		throw new Error("tools must map non-empty tool names to booleans");
	}
	if (
		!Array.isArray(value.bashWhitelist) ||
		value.bashWhitelist.some(
			(prefix) => !isSingleLine(prefix) || !isWhitelistEntry(prefix),
		)
	) {
		throw new Error(
			"bashWhitelist must contain trimmed, single-line literal command prefixes without shell expansion or redirection",
		);
	}
	for (const key of ["planningThinking", "implementationThinking"] as const) {
		if (!THINKING_SETTINGS.includes(value[key] as ThinkingSetting)) {
			throw new Error(`${key} must be one of: ${THINKING_SETTINGS.join(", ")}`);
		}
	}
	if (
		!isSingleLine(value.implementationModel) ||
		(value.implementationModel !== "inherit" &&
			!/^[^/\s]+\/\S+$/.test(value.implementationModel))
	) {
		throw new Error("implementationModel must be inherit or provider/model-id");
	}
}

/** Missing files use defaults; malformed JSON, invalid settings and other I/O errors fail closed. */
export function loadSettings(file: string): PlanSettings {
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return defaultSettings();
		throw error;
	}
	try {
		const settings: unknown = JSON.parse(content);
		validateSettings(settings);
		return settings;
	} catch (error) {
		throw new Error(
			`Invalid plan settings in ${file}: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
}

/** Replace the destination atomically with a private file in the same directory. */
export async function saveSettings(
	file: string,
	settings: PlanSettings,
): Promise<void> {
	validateSettings(settings);
	const content = `${JSON.stringify(settings, null, 2)}\n`;
	let destination = file;
	try {
		// A symlinked personal settings path must update its repo target, not replace the link.
		destination = await realpath(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const directory = dirname(destination);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		// Keep exact permissions even with a restrictive process umask.
		await handle.chmod(0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		await rename(temporary, destination);
	} catch (error) {
		await handle.close().catch(() => {});
		await unlink(temporary).catch(() => {});
		throw error;
	}
}
