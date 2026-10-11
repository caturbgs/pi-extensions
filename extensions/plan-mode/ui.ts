import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	KeybindingsManager,
	Theme,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { isDefaultToolEnabled, isWhitelistEntry } from "./safety.ts";
import type { PlanAction, PlanSettings, ThinkingSetting } from "./types.ts";

type Choice<T extends string> = SelectItem & { value: T };

const ACTIONS: Choice<PlanAction>[] = [
	{
		value: "here",
		label: "Implement here",
		description:
			"Approve the plan and implement in this session, keeping the full conversation.",
	},
	{
		value: "compact",
		label: "Compact, then implement",
		description:
			"Approve the plan, summarize the conversation, then implement with the plan retained.",
	},
	{
		value: "fresh",
		label: "Implement in a fresh session",
		description:
			"Approve the plan and start a new session with the plan, without the earlier conversation.",
	},
	{
		value: "revise",
		label: "Revise the plan",
		description:
			"Keep planning protections on and enter revision instructions in the normal editor.",
	},
	{
		value: "export",
		label: "Export the plan",
		description: "Save the plan as Markdown without starting implementation.",
	},
];

const THINKING_CHOICES: Choice<ThinkingSetting>[] = [
	{
		value: "inherit",
		label: "inherit",
		description: "Keep the session's thinking level from before planning.",
	},
	{
		value: "off",
		label: "off",
		description:
			"Disable extra reasoning where the selected model supports it.",
	},
	{
		value: "minimal",
		label: "minimal",
		description: "Use the smallest reasoning budget for quick, simple tasks.",
	},
	{
		value: "low",
		label: "low",
		description: "Use a small reasoning budget with lower latency.",
	},
	{
		value: "medium",
		label: "medium",
		description: "Balance reasoning depth and response time.",
	},
	{
		value: "high",
		label: "high",
		description:
			"Use deeper reasoning for complex tasks; responses may take longer.",
	},
	{
		value: "xhigh",
		label: "xhigh",
		description: "Request extra-high reasoning on models that support it.",
	},
	{
		value: "max",
		label: "max",
		description:
			"Request the maximum supported reasoning budget; expect more time and cost.",
	},
];

/** Reuse the host's input, selection, keybinding and terminal-width handling. */
class SearchableList implements Component, Focusable {
	private readonly input = new Input({
		prompt: "Search: ",
		placeholder: "Type to filter",
	});
	private list!: SelectList;

	constructor(
		private readonly title: string,
		private readonly items: () => SelectItem[],
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly confirm: (item: SelectItem | null) => void,
		private readonly cancel: () => void,
		private readonly toggle?: (item: SelectItem) => void,
		private readonly warning?: string,
	) {
		this.rebuild();
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	private rebuild(selectedValue?: string): void {
		const query = this.input.getValue().toLowerCase();
		const items = this.items().filter((item) =>
			`${item.value} ${item.label}`.toLowerCase().includes(query),
		);
		this.list = new SelectList(items, Math.max(1, Math.min(items.length, 10)), {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("warning", text),
		});
		if (selectedValue !== undefined) {
			this.list.setSelectedIndex(
				Math.max(
					0,
					items.findIndex((item) => item.value === selectedValue),
				),
			);
		}
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const selected = this.list.getSelectedItem();
		const lines = [this.theme.fg("accent", this.theme.bold(this.title))];
		if (this.warning) {
			lines.push(
				...wrapTextWithAnsi(
					this.theme.fg("warning", this.warning),
					width,
				).slice(0, 3),
			);
		}
		lines.push(
			...this.input.render(Math.max(16, width)),
			"",
			...this.list.render(Math.max(4, width)),
		);
		if (selected?.description) {
			lines.push(
				"",
				...wrapTextWithAnsi(
					this.theme.fg("muted", selected.description),
					width,
				).slice(0, 4),
			);
		}
		lines.push(
			"",
			this.theme.fg(
				"dim",
				this.toggle
					? "Space toggles · Enter saves · Esc cancels"
					: "Enter selects · Esc closes",
			),
		);
		// SelectList's prefix and Input's prompt can exceed very narrow widths.
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.cancel();
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.confirm(this.list.getSelectedItem());
		} else if (this.toggle && matchesKey(data, Key.space)) {
			const selected = this.list.getSelectedItem();
			if (selected) {
				this.toggle(selected);
				this.rebuild(selected.value);
			}
		} else if (
			this.keybindings.matches(data, "tui.select.up") ||
			this.keybindings.matches(data, "tui.select.down")
		) {
			this.list.handleInput(data);
		} else {
			const previous = this.input.getValue();
			this.input.handleInput(data);
			if (previous !== this.input.getValue()) this.rebuild();
		}
		this.tui.requestRender();
	}
}

async function selectChoice<T extends string>(
	ctx: ExtensionContext,
	title: string,
	items: Choice<T>[],
): Promise<T | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`${title} requires TUI mode or an RPC client with dialog support.`,
			"warning",
		);
		return undefined;
	}
	if (ctx.mode !== "tui") {
		const options = items.map(
			(item) => `${item.label} — ${item.description ?? ""}`,
		);
		const result = await ctx.ui.select(title, options);
		return items.find((_item, index) => options[index] === result)?.value;
	}
	return ctx.ui.custom<T | undefined>(
		(tui, theme, keybindings, done) =>
			new SearchableList(
				title,
				() => items,
				tui,
				theme,
				keybindings,
				(item) => {
					const selected = items.find((choice) => choice.value === item?.value);
					if (selected) done(selected.value);
				},
				() => done(undefined),
			),
	);
}

export function chooseAction(
	ctx: ExtensionContext,
): Promise<PlanAction | undefined> {
	return selectChoice(ctx, "Plan ready: choose the next step", ACTIONS);
}

function toolEnabled(
	tool: ToolInfo,
	overrides: Record<string, boolean>,
): boolean {
	return (
		tool.exposure !== "hidden" &&
		(Object.hasOwn(overrides, tool.name)
			? overrides[tool.name]
			: isDefaultToolEnabled(tool))
	);
}

function toolDescription(tool: ToolInfo): string {
	if (tool.exposure === "hidden")
		return "Hidden by the host; disabled and cannot be enabled here.";
	const safety = isDefaultToolEnabled(tool)
		? "Enabled by default: read-only or approved question/todo workflow tool. Read-only hints are not a security guarantee."
		: "Disabled by default. Unsafe/custom tools may change files or external services; enable only tools you trust.";
	const bash =
		tool.name === "bash"
			? " Bash remains restricted to the whitelist; command-prefix checks are not a sandbox."
			: "";
	return `${safety}${bash} Exposure: ${tool.exposure}. ${tool.description}`;
}

async function chooseTools(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: PlanSettings,
): Promise<Record<string, boolean> | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"Tool checkboxes require TUI mode. Other plan settings can use RPC dialogs.",
			"warning",
		);
		return undefined;
	}
	const tools = [...pi.getAllTools()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	const draft = { ...settings.tools };
	for (const tool of tools) {
		if (tool.exposure === "hidden" && Object.hasOwn(draft, tool.name))
			draft[tool.name] = false;
	}
	return ctx.ui.custom<Record<string, boolean> | undefined>(
		(tui, theme, keybindings, done) =>
			new SearchableList(
				"Planning tools",
				() =>
					tools.map((tool) => ({
						value: tool.name,
						label: `[${toolEnabled(tool, draft) ? "x" : " "}] ${tool.name}${tool.exposure === "hidden" ? " (hidden; disabled)" : ""}`,
						description: toolDescription(tool),
					})),
				tui,
				theme,
				keybindings,
				() => done(draft),
				() => done(undefined),
				(item) => {
					const tool = tools.find((candidate) => candidate.name === item.value);
					if (tool && tool.exposure !== "hidden") {
						Object.defineProperty(draft, tool.name, {
							value: !toolEnabled(tool, draft),
							writable: true,
							enumerable: true,
							configurable: true,
						});
					}
				},
				"Defaults: read-only and existing question/todo tools on; other tools off. Custom tools may have side effects. Bash prefix checks are not a sandbox.",
			),
	);
}

/** Edit preferences only; the parent applies them when changing planning/implementation phase. */
export async function configureSettings(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	settings: PlanSettings,
	save: () => Promise<void>,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Plan settings require TUI mode or an RPC client with dialog support.",
			"warning",
		);
		return;
	}
	while (true) {
		const key = await selectChoice(
			ctx,
			"Plan settings (each change saves; Esc closes)",
			[
				{
					value: "tools",
					label: "Planning tools",
					description:
						"Defaults: read-only and existing question/todo workflow tools on; others off. Unsafe custom tools may have side effects; hidden tools stay disabled.",
				},
				{
					value: "bashWhitelist",
					label: "Bash whitelist",
					description: `${settings.bashWhitelist.length} literal command prefixes. One per line; no expansion or redirection. Not a sandbox: arguments may still have side effects.`,
				},
				{
					value: "planningThinking",
					label: "Planning thinking level",
					description: `${settings.planningThinking}. Set reasoning for planning, or inherit the pre-planning session level.`,
				},
				{
					value: "implementationModel",
					label: "Implementation model",
					description: `${settings.implementationModel}. Choose an available provider/model-id, or keep the pre-planning model.`,
				},
				{
					value: "implementationThinking",
					label: "Implementation thinking level",
					description: `${settings.implementationThinking}. Set reasoning for implementation, or inherit the pre-planning level. Unsupported levels may be clamped by the host.`,
				},
			] satisfies Choice<Exclude<keyof PlanSettings, "version">>[],
		);
		if (key === undefined) return;

		const previous = { ...settings };
		if (key === "tools") {
			const tools = await chooseTools(pi, ctx, settings);
			if (tools === undefined) continue;
			settings.tools = tools;
		} else if (key === "bashWhitelist") {
			const text = await ctx.ui.editor(
				"Bash whitelist: one literal prefix per line; no expansion/redirection (not a sandbox)",
				settings.bashWhitelist.join("\n"),
			);
			if (text === undefined) continue;
			const prefixes = [
				...new Set(
					text
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter(Boolean),
				),
			];
			if (
				prefixes.some(
					(prefix) =>
						// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject line and terminal controls in command prefixes.
						/[\x00-\x1f\x7f]/.test(prefix) || !isWhitelistEntry(prefix),
				)
			) {
				ctx.ui.notify(
					"Use literal command prefixes without shell expansion, redirection, or command chains. Edit the whitelist again.",
					"error",
				);
				continue;
			}
			settings.bashWhitelist = prefixes;
		} else if (key === "implementationModel") {
			const models: Choice<string>[] = ctx.modelRegistry
				.getAvailable()
				.map((model) => ({
					value: `${model.provider}/${model.id}`,
					label: `${model.provider}/${model.id}`,
					description: `${model.name}. ${model.reasoning ? "Supports reasoning; available levels depend on the model." : "Does not support extra reasoning."}`,
				}))
				.sort((a, b) => a.value.localeCompare(b.value));
			const model = await selectChoice(ctx, "Implementation model", [
				{
					value: "inherit",
					label: "inherit",
					description:
						"Keep the model used before planning. Only models with available credentials are listed below.",
				},
				...models,
			]);
			if (model === undefined) continue;
			settings.implementationModel = model;
		} else {
			const thinking = await selectChoice(
				ctx,
				`${key === "planningThinking" ? "Planning" : "Implementation"} thinking level (model support varies)`,
				THINKING_CHOICES,
			);
			if (thinking === undefined) continue;
			settings[key] = thinking;
		}

		try {
			await save();
			ctx.ui.notify("Plan setting saved.", "info");
		} catch (error) {
			Object.assign(settings, previous);
			ctx.ui.notify(
				`Could not save plan settings: ${error instanceof Error ? error.message : String(error)}. Change reverted; try again.`,
				"error",
			);
		}
	}
}
