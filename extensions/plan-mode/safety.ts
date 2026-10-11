import type { ToolInfo } from "@earendil-works/pi-coding-agent";

// Unknown tools are opt-in. Workflow tools only mutate session-local planning state.
const READ_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"recall",
	"web_search",
]);
const WORKFLOW_TOOLS = new Set(["ask_user_question", "todo", "questionnaire"]);
export function isDefaultToolEnabled(
	tool: Pick<ToolInfo, "name" | "annotations">,
): boolean {
	return (
		tool.annotations?.readOnlyHint === true ||
		READ_TOOLS.has(tool.name) ||
		WORKFLOW_TOOLS.has(tool.name)
	);
}

export const DEFAULT_BASH_WHITELIST = [
	"pwd",
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"rg",
	"grep",
	"find",
	"stat",
	"file",
	"du",
	"df",
	"tree",
	"uname",
	"whoami",
	"git --no-pager status",
	"git --no-pager ls-files",
	"git --no-pager log --no-ext-diff --no-textconv",
	"git --no-pager diff --no-ext-diff --no-textconv",
	"git --no-pager show --no-ext-diff --no-textconv",
];

/** Small, deliberately restrictive shell grammar; never a general shell sandbox. */
export function parseCommand(command: string): string[][] | undefined {
	if (!command.trim() || /[\x00-\x08\x0b-\x1f\x7f$`<>\\(){}!]/.test(command))
		return undefined;
	const commands: string[][] = [];
	let words: string[] = [],
		word = "",
		started = false,
		quote = "";
	const endWord = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	const endCommand = () => {
		endWord();
		if (!words.length) return false;
		commands.push(words);
		words = [];
		return true;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) quote = "";
			else word += c;
			started = true;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			started = true;
			continue;
		}
		// Globs can expand an innocent argument into a destructive option (e.g. -de* → -delete).
		if (c === "#" || c === "*" || c === "?" || c === "[") return undefined;
		if (c === ";" || c === "\n" || c === "|" || c === "&") {
			if (c === "&" && command[i + 1] !== "&") return undefined;
			if ((c === "&" || c === "|") && command[i + 1] === c) i++;
			if (!endCommand()) return undefined;
			continue;
		}
		if (/\s/.test(c)) endWord();
		else {
			word += c;
			started = true;
		}
	}
	if (quote || !endCommand()) return undefined;
	return commands;
}

export function isWhitelistEntry(entry: string): boolean {
	const parsed = parseCommand(entry);
	return (
		parsed?.length === 1 &&
		parsed[0].length > 0 &&
		/^[a-zA-Z0-9_.-]+$/.test(parsed[0][0])
	);
}

export function checkBash(
	command: unknown,
	whitelist: string[],
): { allowed: boolean; reason?: string } {
	if (typeof command !== "string")
		return { allowed: false, reason: "Missing command." };
	const commands = parseCommand(command);
	if (!commands)
		return {
			allowed: false,
			reason:
				"Shell expansion, redirection, escapes, background execution, or invalid shell syntax is not allowed.",
		};
	const prefixes = whitelist
		.filter(isWhitelistEntry)
		.map((entry) => parseCommand(entry)![0]);
	for (const words of commands) {
		const [name, ...args] = words;
		if (
			!prefixes.some((prefix) => prefix.every((word, i) => words[i] === word))
		) {
			return {
				allowed: false,
				reason: `Command is not allowlisted: ${name}. Configure literal command prefixes in /plan settings.`,
			};
		}
		// Even allowlisted commands cannot use these well-known write/execute switches.
		const unsafe =
			(name === "find" &&
				args.some((a) =>
					/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(
						a,
					),
				)) ||
			(name === "rg" &&
				args.some((a) => /^--(pre|pre-glob|hostname-bin)(=|$)/.test(a))) ||
			(name === "file" &&
				args.some(
					(a) =>
						a === "--compile" ||
						(a.startsWith("-") &&
							!a.startsWith("--") &&
							a.slice(1).includes("C")),
				)) ||
			(name === "git" &&
				args.some(
					(a) =>
						/^--(output|ext-diff|textconv|exec-path|config-env)(=|$)/.test(a) ||
						a === "-c" ||
						a === "--paginate",
				)) ||
			(name === "sort" && args.some((a) => /^(-o|--output)/.test(a))) ||
			(name === "fd" && args.some((a) => /^(-x|-X|--exec)/.test(a))) ||
			(name === "sed" && args.some((a) => /^(-i|--in-place)/.test(a))) ||
			(name === "git" &&
				args.includes("diff") &&
				!args.includes("--no-ext-diff")) ||
			(name === "git" &&
				(args.includes("diff") ||
					args.includes("show") ||
					args.includes("log")) &&
				!args.includes("--no-textconv"));
		if (unsafe)
			return {
				allowed: false,
				reason: `Write/execute option blocked for ${name}.`,
			};
	}
	return { allowed: true };
}
