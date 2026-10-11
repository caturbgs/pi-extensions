/**
 * Pi Titlebar Extension
 *
 * Shows the active session name (or the current directory when no session is
 * active) alongside the current agent state.
 */

import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type TitleState = "idle" | "working" | "needs-input" | "finished";

export function baseTitle(session: string | undefined, cwd: string): string {
	return `π - ${session || path.basename(cwd)}`;
}

export function statusTitle(
	state: Exclude<TitleState, "idle">,
	session: string | undefined,
	cwd: string,
	frame?: string,
): string {
	const prefix = frame ? `${frame} ` : "";
	const label =
		state === "needs-input"
			? "Needs input"
			: state[0].toUpperCase() + state.slice(1);
	const context = session || path.basename(cwd);
	return `${prefix}π - ${label} — ${context}`;
}

function getBaseTitle(pi: ExtensionAPI): string {
	return baseTitle(pi.getSessionName(), process.cwd());
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	let state: TitleState = "idle";

	function setTitle(ctx: ExtensionContext, frame?: string) {
		if (state === "idle") {
			ctx.ui.setTitle(getBaseTitle(pi));
			return;
		}
		ctx.ui.setTitle(
			statusTitle(state, pi.getSessionName(), process.cwd(), frame),
		);
	}

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		setTitle(ctx);
	}

	function startAnimation(ctx: ExtensionContext) {
		if (timer) clearInterval(timer);
		frameIndex = 0;
		setTitle(ctx, BRAILLE_FRAMES[frameIndex]);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			setTitle(ctx, frame);
			frameIndex++;
		}, 80);
	}

	function reset(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		state = "idle";
		setTitle(ctx);
	}

	pi.on("before_agent_start", (_event, ctx) => {
		state = "working";
		startAnimation(ctx);
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		state = "needs-input";
		stopAnimation(ctx);
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		if (state !== "needs-input" || ctx.isIdle()) return;
		state = "working";
		startAnimation(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		state = "finished";
		stopAnimation(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		reset(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		setTitle(
			ctx,
			state === "working"
				? BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length]
				: undefined,
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		reset(ctx);
	});
}
