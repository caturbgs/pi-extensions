import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type ThinkingSetting = "inherit" | ThinkingLevel;
export interface PlanSettings {
  version: 1;
  tools: Record<string, boolean>;
  bashWhitelist: string[];
  planningThinking: ThinkingSetting;
  implementationModel: string;
  implementationThinking: ThinkingSetting;
}
export type PlanAction = "here" | "compact" | "fresh" | "revise" | "export";
export interface PlanState {
  version: 1;
  phase: "off" | "planning" | "ready" | "revising";
  plan: string;
  originalTools: string[];
  allowedTools: string[];
  originalThinking: ThinkingLevel;
  originalModel?: string;
}
export const READY_MARKER = "<!-- pi-plan-ready -->";
