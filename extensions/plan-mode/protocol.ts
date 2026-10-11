import { READY_MARKER } from "./types.ts";

export function assistantText(message: {
	role: string;
	content?: unknown;
}): string {
	if (message.role !== "assistant" || !Array.isArray(message.content))
		return "";
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
export function proposedPlan(message: {
	role: string;
	content?: unknown;
	stopReason?: string;
}): string | undefined {
	if (
		message.stopReason !== "stop" ||
		!Array.isArray(message.content) ||
		message.content.some((part) => part?.type === "toolCall")
	)
		return undefined;
	const text = assistantText(message).trim();
	if (!text.endsWith(READY_MARKER)) return undefined;
	const plan = text.slice(0, -READY_MARKER.length).trim();
	if (!/^# Proposed plan\s*\n/i.test(plan) || plan.length < 40)
		return undefined;
	return plan;
}
