import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkBash, isDefaultToolEnabled } from "./safety.ts";
import { defaultSettings, loadSettings, saveSettings } from "./settings.ts";
import { atomicWrite, PlanBackup } from "./storage.ts";
import { proposedPlan } from "./protocol.ts";
import { READY_MARKER, type PlanSettings, type PlanState } from "./types.ts";
import { chooseAction, configureSettings } from "./ui.ts";

const STATE_ENTRY = "plan-mode-v1";
const FRESH_ENTRY = "plan-mode-implementation-v1";
const FRESH_READY = "plan-mode-implementation-ready-v1";
interface ImplementationRequest {
  plan: string;
  model: string;
  thinking: PlanState["originalThinking"];
  tools: string[];
}

function validState(value: unknown): value is PlanState {
  if (!value || typeof value !== "object") return false;
  const s = value as PlanState;
  return (
    s.version === 1 &&
    ["off", "planning", "ready", "revising"].includes(s.phase) &&
    typeof s.plan === "string" &&
    Array.isArray(s.originalTools) &&
    s.originalTools.every((t) => typeof t === "string") &&
    Array.isArray(s.allowedTools) &&
    s.allowedTools.every((t) => typeof t === "string") &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(s.originalThinking)
  );
}

export default function planMode(pi: ExtensionAPI): void {
  createPlanMode(
    pi,
    dirname(fileURLToPath(import.meta.url)),
    join(getAgentDir(), "plan-mode-settings.json"),
  );
}

/** Explicit storage paths let tests exercise the real workflow without touching user state. */
export function createPlanMode(pi: ExtensionAPI, directory: string, settingsFile: string): void {
  const backup = new PlanBackup(directory);
  let settings: PlanSettings;
  let settingsError: unknown;
  try {
    settings = loadSettings(settingsFile);
  } catch (error) {
    settingsError = error;
    settings = defaultSettings();
  }
  let state: PlanState | undefined;
  let disposed = false;
  let sessionId = "";
  let automaticallyPresent = false;
  let presenting = false;
  let compacting = false;

  const active = () => state !== undefined && state.phase !== "off";
  const notifyError = (ctx: ExtensionContext, error: unknown) =>
    ctx.ui.notify(`Plan mode: ${error instanceof Error ? error.message : String(error)}`, "error");
  function status(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "plan-mode",
      active() ? ctx.ui.theme.fg("warning", `plan: ${state!.phase}`) : undefined,
    );
    ctx.ui.setWidget(
      "plan-mode",
      active()
        ? [
            state!.phase === "ready"
              ? "Plan ready • /plan opens approval • nothing is implemented until approval"
              : "Plan mode • research → questions → existing todo → proposed plan • /plan settings • /plan exit",
          ]
        : undefined,
    );
  }
  function persist(ctx: ExtensionContext): void {
    if (!state) return;
    pi.appendEntry(STATE_ENTRY, structuredClone(state));
    backup.enqueue({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, state }, (error) =>
      notifyError(ctx, error),
    );
    status(ctx);
  }
  function selectTools(): string[] {
    return pi
      .getAllTools()
      .filter(
        (tool) =>
          tool.exposure !== "hidden" &&
          (Object.hasOwn(settings.tools, tool.name)
            ? settings.tools[tool.name]
            : isDefaultToolEnabled(tool)),
      )
      .map((tool) => tool.name);
  }
  function applyPlanning(): void {
    if (!state || !active()) return;
    pi.setActiveTools(state.allowedTools);
    if (settings.planningThinking !== "inherit") pi.setThinkingLevel(settings.planningThinking);
  }
  function begin(ctx: ExtensionContext): void {
    if (!active()) {
      state = {
        version: 1,
        phase: "planning",
        plan: "",
        originalTools: pi.getActiveTools(),
        allowedTools: selectTools(),
        originalThinking: pi.getThinkingLevel(),
        originalModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      };
    } else state!.phase = state!.plan ? "revising" : "planning";
    automaticallyPresent = false;
    applyPlanning();
    persist(ctx);
  }
  function exitPlan(ctx: ExtensionContext): void {
    if (!active()) {
      ctx.ui.notify("Plan mode is not active.", "info");
      return;
    }
    state!.phase = "off";
    automaticallyPresent = false;
    pi.setActiveTools(state!.originalTools);
    pi.setThinkingLevel(state!.originalThinking);
    persist(ctx);
    ctx.ui.notify("Plan mode exited. The proposed plan remains in this session.", "info");
  }

  function implementationRequest(): ImplementationRequest {
    return {
      plan: state!.plan,
      tools: [...state!.originalTools],
      model:
        settings.implementationModel === "inherit"
          ? (state!.originalModel ?? "inherit")
          : settings.implementationModel,
      thinking:
        settings.implementationThinking === "inherit"
          ? state!.originalThinking
          : settings.implementationThinking,
    };
  }
  async function applyImplementation(
    ctx: ExtensionContext,
    request: ImplementationRequest,
  ): Promise<boolean> {
    if (request.model !== "inherit") {
      const slash = request.model.indexOf("/");
      const model = ctx.modelRegistry.find(
        request.model.slice(0, slash),
        request.model.slice(slash + 1),
      );
      if (!model)
        throw new Error(
          `Implementation model is unavailable: ${request.model}. Choose another in /plan settings.`,
        );
      if (!(await pi.setModel(model)))
        throw new Error(
          `Authentication is unavailable for ${request.model}. Use /login or change /plan settings.`,
        );
    }
    pi.setThinkingLevel(request.thinking);
    return true;
  }
  function implementationPrompt(plan: string): string {
    return `Implement the following user-approved plan. Planning restrictions are lifted. Use the existing todo tool to track implementation when available. Verify changes with relevant tests and report results. Treat the plan as the specification, not permission to expand scope.\n\n${plan}`;
  }
  async function exportPlan(ctx: ExtensionContext): Promise<void> {
    const file = join(ctx.cwd, "PLAN.md");
    const exists = await access(file).then(
      () => true,
      () => false,
    );
    if (
      exists &&
      !(await ctx.ui.confirm(
        "Replace PLAN.md?",
        `This replaces the existing ${file}. The internal backup remains available.`,
      ))
    )
      return;
    await atomicWrite(file, `${state!.plan}\n`);
    ctx.ui.notify(`Plan exported to ${file}`, "info");
  }
  async function present(ctx: ExtensionCommandContext): Promise<void> {
    if (!state?.plan || state.phase !== "ready" || presenting) return;
    presenting = true;
    const expectedSession = ctx.sessionManager.getSessionId();
    const expectedPlan = state.plan;
    const expectedCwd = ctx.cwd;
    try {
      for (;;) {
        const action = await chooseAction(ctx);
        if (disposed || !action || ctx.sessionManager.getSessionId() !== expectedSession) return;
        if (state?.phase !== "ready" || state.plan !== expectedPlan) {
          ctx.ui.notify(
            "The plan changed while approval was open. Review the updated proposal before approval.",
            "warning",
          );
          return;
        }
        if (action === "export") {
          await exportPlan(ctx);
          continue;
        }
        if (action === "revise") {
          state.phase = "revising";
          persist(ctx);
          ctx.ui.notify(
            "Revise in the normal pi editor. Slash commands still work; submit your changes to produce an updated plan.",
            "info",
          );
          return;
        }
        const request = implementationRequest();
        await backup.flush();
        if (disposed || state?.phase !== "ready" || state.plan !== expectedPlan) return;
        if (action === "fresh") {
          // Validate before replacing the session; the new runtime applies settings from plain data.
          if (request.model !== "inherit") {
            const slash = request.model.indexOf("/");
            const model = ctx.modelRegistry.find(
              request.model.slice(0, slash),
              request.model.slice(slash + 1),
            );
            if (!model) throw new Error(`Implementation model unavailable: ${request.model}`);
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok) throw new Error(`Implementation authentication failed: ${auth.error}`);
          }
          if (disposed) return;
          const parentSession = ctx.sessionManager.getSessionFile();
          const prompt = implementationPrompt(request.plan);
          await ctx.newSession({
            parentSession,
            setup: async (manager) => {
              manager.appendCustomEntry(FRESH_ENTRY, request);
            },
            withSession: async (fresh) => {
              const ready = fresh.sessionManager
                .getBranch()
                .some(
                  (entry) =>
                    entry.type === "custom" &&
                    entry.customType === FRESH_READY &&
                    entry.data === true,
                );
              try {
                if (ready) {
                  await fresh.sendUserMessage(prompt);
                  try {
                    await backup.clearSession(expectedSession, expectedPlan, expectedCwd);
                  } catch (error) {
                    notifyError(fresh, error);
                  }
                } else
                  fresh.ui.notify(
                    "Implementation settings could not be applied. The source session and its proposed plan are unchanged.",
                    "error",
                  );
              } catch (error) {
                fresh.ui.notify(
                  `Implementation could not start: ${error instanceof Error ? error.message : String(error)}. The source plan remains available.`,
                  "error",
                );
              }
            },
          });
          // Both this pi and ctx are invalid after replacement. Do no session work here.
          return;
        }
        if (action === "compact") {
          compacting = true;
          try {
            await new Promise<void>((resolve, reject) =>
              ctx.compact({
                customInstructions:
                  "Preserve the planning discoveries, requirements, constraints, relevant files and decisions. The exact approved plan will be provided again after compaction. Do not begin implementation.",
                onComplete: () => resolve(),
                onError: reject,
              }),
            );
          } finally {
            compacting = false;
          }
        }
        if (disposed || state?.phase !== "ready" || state.plan !== expectedPlan) return;
        await applyImplementation(ctx, request);
        if (disposed) return;
        state.phase = "off";
        pi.setActiveTools(request.tools);
        persist(ctx);
        await pi.sendUserMessage(implementationPrompt(request.plan));
        try {
          await backup.clearSession(expectedSession, expectedPlan, expectedCwd);
        } catch (error) {
          notifyError(ctx, error);
        }
        return;
      }
    } catch (error) {
      if (disposed) throw error;
      notifyError(ctx, error);
    } finally {
      presenting = false;
    }
  }

  pi.registerCommand("plan", {
    description:
      "Start planning with /plan [prompt]; configure with /plan settings; exit with /plan exit; reopen a ready plan with /plan",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trimStart();
      if (/\s/.test(prefix)) return null;
      const options = [
        {
          value: "settings",
          label: "settings",
          description: "Configure Plan Mode tools, bash whitelist, and models",
        },
        {
          value: "exit",
          label: "exit",
          description: "Leave Plan Mode and restore your original tools and thinking level",
        },
      ];
      const matches = options.filter(({ value }) => value.startsWith(prefix.toLowerCase()));
      return matches.length ? matches : null;
    },

    handler: async (args, ctx) => {
      const isExit = args.trim() === "exit";
      if (compacting && !isExit) {
        ctx.ui.notify("Wait for plan compaction to finish.", "warning");
        return;
      }

      await ctx.waitForIdle();
      if (disposed) return;
      if (isExit) {
        exitPlan(ctx);
        return;
      }

      if (args.trim() === "settings") {
        await configureSettings(pi, ctx, settings, async () => {
          await saveSettings(settingsFile, settings);
        });
        if (disposed) return;
        if (active()) {
          state!.allowedTools = selectTools();
          if (settings.planningThinking === "inherit") pi.setThinkingLevel(state!.originalThinking);
          applyPlanning();
          persist(ctx);
        }
        return;
      }
      if (!args.trim() && state?.phase === "ready") {
        await present(ctx);
        return;
      }
      const prompt = args.trim();
      begin(ctx);
      if (prompt) pi.sendUserMessage(prompt);
      else ctx.ui.notify("Plan mode started. Write your request in the normal pi editor.", "info");
    },
  });

  function planningContract() {
    const toolNames = state!.allowedTools;
    const questions = toolNames.filter((name) => /ask_user_question|questionnaire/.test(name));
    const todos = toolNames.filter((name) => name === "todo");
    return {
      message: {
        customType: "plan-mode-contract",
        display: false,
        content: `[PLAN MODE ACTIVE]\nDo not implement or modify project files. Only the selected tools are permitted; bash, if enabled, is restricted by a literal command-prefix whitelist. Use existing tools; never create a new planning tool.\nExplore relevant code, identify constraints and risks. ${questions.length ? `Ask clarifying questions using ${questions.join(", ")} only when a user decision is needed.` : "Question tools are disabled/unavailable; ask needed questions in conversation and wait for answers."}\n${todos.length ? "Use the existing todo tool for multi-step planning goals. Track research/decision work, not premature implementation." : "The existing todo tool is disabled/unavailable; organize planning goals in your reasoning."}\nWhen the plan is decision-ready, write the COMPLETE self-contained Markdown plan yourself in your final assistant response. Start with '# Proposed plan'. Include goal, decisions/assumptions, exact files/areas, ordered implementation steps, tests, acceptance criteria, and risks. Add a compact diagram if helpful. Do not merely refer to or cat a plan file. The extension mirrors your response to a backup in the background; do not write that file with tools.\nEnd the final response with this exact HTML comment on its own line: ${READY_MARKER}\nOnly use that marker for a completed proposed plan, never with tool calls, open questions, or interim progress. Then stop and wait for the user's approval.\n${state!.phase === "revising" && state!.plan ? `Revise the previously proposed plan with the user's changes, asking needed questions again. Publish a complete replacement, not only a diff. Previous plan:\n${state!.plan}` : ""}`,
      },
    };
  }
  pi.on("before_agent_start", (_event, ctx) => {
    if (!active()) return;
    if (state!.phase === "ready") {
      state!.phase = "revising";
      persist(ctx);
    }
    applyPlanning();
    return planningContract();
  });
  pi.on("context", (event) => {
    const isContract = (message: (typeof event.messages)[number]) =>
      "customType" in message && message.customType === "plan-mode-contract";
    const latest = active() ? event.messages.findLastIndex(isContract) : -1;
    const messages = event.messages.filter(
      (message, index) => !isContract(message) || index === latest,
    );
    if (active() && latest === -1) {
      // Automatic compaction can continue the same agent run without before_agent_start.
      messages.push({
        role: "custom",
        ...planningContract().message,
        timestamp: Date.now(),
      });
    }
    return { messages };
  });
  pi.on("tool_call", (event) => {
    if (!active()) return;
    if (!state!.allowedTools.includes(event.toolName))
      return {
        block: true,
        reason: `Plan mode: ${event.toolName} is OFF. Enable it explicitly in /plan settings if needed. Nested tool calls follow the same policy.`,
      };
    if (event.toolName === "bash") {
      const result = checkBash(event.input.command, settings.bashWhitelist);
      if (!result.allowed) return { block: true, reason: `Plan mode: ${result.reason}` };
    }
  });
  pi.on("user_bash", (event) => {
    if (!active()) return;
    const result = state!.allowedTools.includes("bash")
      ? checkBash(event.command, settings.bashWhitelist)
      : { allowed: false, reason: "bash is OFF in /plan settings." };
    if (!result.allowed)
      return {
        result: {
          output: `Plan mode: ${result.reason}`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
  });
  pi.on("message_start", (event, ctx) => {
    if (
      active() &&
      state!.phase === "ready" &&
      (event.message.role === "user" || event.message.role === "assistant")
    ) {
      // Queued follow-ups run inside the same loop and bypass before_agent_start.
      state!.phase = "revising";
      automaticallyPresent = false;
      persist(ctx);
    }
  });
  pi.on("message_end", (event, ctx) => {
    if (!active()) return;
    const plan = proposedPlan(event.message);
    if (!plan) return;
    state!.plan = plan;
    state!.phase = "ready";
    automaticallyPresent = true;
    persist(ctx); // Session state immediately; disk I/O runs independently in the queue.
  });
  pi.on("agent_settled", (event, ctx) => {
    if (
      event.aborted ||
      !automaticallyPresent ||
      !active() ||
      state!.phase !== "ready" ||
      ctx.hasPendingMessages()
    )
      return;
    automaticallyPresent = false;
    // pi defers command dispatch until settlement is over. Session controls run ONLY in that command context.
    if (ctx.hasUI) pi.sendUserMessage("/plan", { expandPromptTemplates: true });
  });

  async function restore(ctx: ExtensionContext, recoverDisk: boolean): Promise<void> {
    const previous = state;
    state = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    automaticallyPresent = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && validState(entry.data))
        state = structuredClone(entry.data);
    }
    if (!active() && previous && previous.phase !== "off") {
      pi.setActiveTools(state?.originalTools ?? previous.originalTools);
      pi.setThinkingLevel(state?.originalThinking ?? previous.originalThinking);
    }
    const hasAnyPlanState = ctx.sessionManager
      .getEntries()
      .some((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY);
    if (!state && recoverDisk && !hasAnyPlanState) {
      const recovered = await backup.recover(sessionId, ctx.cwd);
      if (validState(recovered) && recovered.phase !== "off") {
        // Recover only missing session state; never import a backup over a branch-owned state.
        state = recovered;
        state.phase = "revising";
        pi.appendEntry(STATE_ENTRY, structuredClone(state));
        ctx.ui.notify(
          "Recovered a plan backup. Use /plan with a request to review and publish the complete plan in this conversation before approving it.",
          "warning",
        );
      }
    }
    applyPlanning();
    status(ctx);
    if (state?.phase === "ready")
      ctx.ui.notify(
        "Proposed plan restored from this session. /plan reopens approval; new input revises it.",
        "info",
      );
  }
  pi.on("session_start", async (_event, ctx) => {
    if (settingsError) {
      notifyError(ctx, settingsError);
      settingsError = undefined;
    }
    await restore(ctx, true);
    const branch = ctx.sessionManager.getBranch();
    const requestEntry = branch.find(
      (entry) => entry.type === "custom" && entry.customType === FRESH_ENTRY,
    );
    const initialized = branch.some(
      (entry) => entry.type === "custom" && entry.customType === FRESH_READY,
    );
    if (requestEntry?.type === "custom" && !initialized) {
      try {
        const request = requestEntry.data as ImplementationRequest;
        await applyImplementation(ctx, request);
        pi.setActiveTools(request.tools);
        pi.appendEntry(FRESH_READY, true);
      } catch (error) {
        pi.appendEntry(FRESH_READY, false);
        notifyError(ctx, error);
      }
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx, false);
  });
  pi.on("session_shutdown", async () => {
    disposed = true;
    await backup.flush();
  });
}
