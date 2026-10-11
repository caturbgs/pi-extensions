/**
 * Pi Notify Extension
 *
 * Sends native notifications when Pi needs a response or a complete agent run
 * settles. Supports Ghostty/iTerm2/WezTerm (OSC 777), Kitty (OSC 99), and
 * Windows Terminal in WSL (OSC 9).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const FALLBACK_COMPLETION = "Task completed; review the final response.";
const FALLBACK_INPUT = "Pi is waiting for your response.";
const PREVIEW_LIMIT = 180;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

/** Remove terminal controls and OSC delimiters before passing text to a notifier. */
export function sanitizeNotificationText(value: string): string {
	return value
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replaceAll(";", ":")
		.replace(/\s+/g, " ")
		.trim();
}

function stripMarkdownDecoration(value: string): string {
	return value
		.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+[.)]\s+)/, "")
		.replace(/^(`{1,3}|\*{1,3}|_{1,3})(.+)\1$/, "$2")
		.trim();
}

/** Return a concise, single-line notification preview without leaking control codes. */
export function notificationPreview(
	value: string | undefined,
	fallback = FALLBACK_COMPLETION,
): string {
	let inCodeFence = false;
	let line: string | undefined;
	for (const rawLine of value?.split(/\r?\n/) ?? []) {
		if (/^\s*`{3,}/.test(rawLine)) {
			inCodeFence = !inCodeFence;
			continue;
		}
		const candidate = stripMarkdownDecoration(rawLine);
		if (!inCodeFence && candidate) {
			line = candidate;
			break;
		}
	}
	const preview = sanitizeNotificationText(line ?? fallback);
	if (preview.length <= PREVIEW_LIMIT) return preview || fallback;
	return `${preview.slice(0, PREVIEW_LIMIT - 1).trimEnd()}…`;
}

/** Extract text from the latest assistant message on the active session branch. */
export function latestAssistantText(
	entries: readonly unknown[],
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			!isRecord(entry) ||
			entry.type !== "message" ||
			!isRecord(entry.message)
		)
			continue;
		const message = entry.message;
		if (message.role !== "assistant" || !Array.isArray(message.content))
			continue;
		const text = message.content
			.filter(isRecord)
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("\n");
		if (text.trim()) return text;
	}
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC9(title: string, body: string): void {
	process.stdout.write(`\x1b]9;${title}: ${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part.
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

export function shouldEmitBell(mode: ExtensionContext["mode"]): boolean {
	return mode === "tui";
}

export function emitBell(ctx: Pick<ExtensionContext, "mode">): void {
	if (shouldEmitBell(ctx.mode)) process.stdout.write("\x07");
}

function notify(title: string, body: string): void {
	const safeTitle = sanitizeNotificationText(title) || "Pi";
	const safeBody = notificationPreview(body, FALLBACK_COMPLETION);
	if (process.env.WT_SESSION) {
		notifyOSC9(safeTitle, safeBody);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(safeTitle, safeBody);
	} else {
		notifyOSC777(safeTitle, safeBody);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("ui_prompt_start", (event, ctx) => {
		const detail = notificationPreview(
			event.title,
			`${FALLBACK_INPUT} (${event.kind})`,
		);
		notify("Pi needs your input", detail);
		emitBell(ctx);
	});

	// `agent_end` fires after each low-level run; Pi may still retry, compact,
	// or continue with queued follow-ups. `agent_settled` guarantees the result
	// is final, so it produces exactly one completion notification per run.
	pi.on("agent_settled", (_event, ctx) => {
		const summary = notificationPreview(
			latestAssistantText(ctx.sessionManager.getBranch()),
		);
		notify("Pi finished", summary);
		emitBell(ctx);
	});
}
