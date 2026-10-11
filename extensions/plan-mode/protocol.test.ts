import { expect, test } from "bun:test";
import { proposedPlan } from "./protocol.ts";
import { READY_MARKER } from "./types.ts";
const plan =
	"# Proposed plan\n\n## Goal\nImplement a reliable workflow.\n\n1. Add tests.\n2. Verify results.";
const message = (text: string, stopReason = "stop") => ({
	role: "assistant",
	stopReason,
	content: [{ type: "text", text }],
});
test("explicit completed plan is captured exactly", () =>
	expect(proposedPlan(message(`${plan}\n\n${READY_MARKER}`))).toBe(plan));
test("ordinary final responses and partial/aborted output are not approvals", () => {
	expect(proposedPlan(message(plan))).toBeUndefined();
	expect(proposedPlan(message(`Progress. ${READY_MARKER}`))).toBeUndefined();
	for (const reason of ["error", "aborted", "toolUse", "length"])
		expect(
			proposedPlan(message(`${plan}\n${READY_MARKER}`, reason)),
		).toBeUndefined();
	expect(
		proposedPlan(
			message(`${plan}\n${READY_MARKER}\nNeed a question answered.`),
		),
	).toBeUndefined();
});
test("a plan cannot complete alongside a tool call", () => {
	const m = message(`${plan}\n${READY_MARKER}`);
	expect(
		proposedPlan({ ...m, content: [...m.content, { type: "toolCall" }] }),
	).toBeUndefined();
});
