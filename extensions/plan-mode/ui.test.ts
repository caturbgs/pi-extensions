import { expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  getKeybindings,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { defaultSettings } from "./settings.ts";
import { chooseAction, configureSettings } from "./ui.ts";

type Screen = Component & Partial<Focusable>;
type Interaction = (screen: Screen) => void;

function typeText(screen: Screen, text: string): void {
  for (const character of text) screen.handleInput?.(character);
}
function select(text: string): Interaction {
  return (screen) => {
    typeText(screen, text);
    screen.handleInput?.("\r");
  };
}
const cancel: Interaction = (screen) => screen.handleInput?.("\x1b");

function harness(interactions: Interaction[] = [], mode: ExtensionCommandContext["mode"] = "tui") {
  const notifications: { message: string; type?: string }[] = [];
  const editorCalls: { title: string; prefill?: string }[] = [];
  const editorResults: (string | undefined)[] = [];
  const rpcChoices: ((options: string[]) => string | undefined)[] = [];
  let renderRequests = 0;
  let color = "36";
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    modelRegistry: {
      getAvailable: () => [
        {
          provider: "vendor",
          id: "model/one",
          name: "Model One",
          reasoning: true,
        },
        {
          provider: "vendor",
          id: "plain",
          name: "Plain Model",
          reasoning: false,
        },
      ],
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      editor: async (title: string, prefill?: string) => {
        editorCalls.push({ title, prefill });
        return editorResults.shift();
      },
      select: async (_title: string, options: string[]) => {
        const choice = rpcChoices.shift();
        expect(choice).toBeDefined();
        return choice?.(options);
      },
      custom: (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
        expect(mode).toBe("tui");
        const interaction = interactions.shift();
        expect(interaction).toBeDefined();
        return new Promise((resolve, reject) => {
          try {
            const screen = factory(
              { requestRender: () => renderRequests++ } as never,
              {
                fg: (_token: string, text: string) => `\x1b[${color}m${text}\x1b[0m`,
                bold: (text: string) => text,
              } as never,
              getKeybindings() as never,
              resolve,
            ) as Screen;
            screen.focused = true;
            interaction?.(screen);
          } catch (error) {
            reject(error);
          }
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    notifications,
    editorCalls,
    editorResults,
    rpcChoices,
    remaining: () => interactions.length,
    renderRequests: () => renderRequests,
    setColor: (next: string) => {
      color = next;
    },
  };
}

function api(tools: Partial<ToolInfo>[] = []): ExtensionAPI {
  return { getAllTools: () => tools } as unknown as ExtensionAPI;
}

for (const action of ["here", "compact", "fresh", "revise", "export"] as const) {
  test(`chooseAction returns ${action} with descriptions for all five actions`, async () => {
    const h = harness([
      (screen) => {
        const text = screen.render(240).join("\n");
        expect(text).toContain("Implement here");
        expect(text).toContain("Compact, then implement");
        expect(text).toContain("fresh session");
        expect(text).toContain("normal editor");
        expect(text).toContain("Markdown");
        select(action)(screen);
      },
    ]);
    expect(await chooseAction(h.ctx)).toBe(action);
    expect(h.remaining()).toBe(0);
  });
}

test("action cancellation, search without results, resize and focus are safe", async () => {
  const h = harness([
    (screen) => {
      expect(screen.render(80).join("\n")).toContain(CURSOR_MARKER);
      for (const width of [0, 1, 2, 3, 8, 20, 40, 80]) {
        for (const line of screen.render(width))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      h.setColor("31");
      screen.invalidate();
      expect(screen.render(80).join("\n")).toContain("\x1b[31m");
      typeText(screen, "no-such-action");
      screen.handleInput?.("\r"); // No match must not accidentally approve a plan.
      cancel(screen);
    },
  ]);
  expect(await chooseAction(h.ctx)).toBeUndefined();
  expect(h.renderRequests()).toBeGreaterThan(0);
});

test("tools show all exposures, safe/workflow defaults, unsafe warnings and locked hidden tools", async () => {
  const settings = defaultSettings();
  settings.tools.hidden = true;
  const h = harness([
    select("tools"),
    (screen) => {
      const text = screen.render(240).join("\n");
      for (const name of ["read", "todo", "ask_user_question", "custom_read", "deferred_read"])
        expect(text).toContain(`[x] ${name}`);
      for (const name of ["custom_write", "bash", "codemode_tool"])
        expect(text).toContain(`[ ] ${name}`);
      expect(text).toContain("hidden; disabled");
      expect(text).toContain("Unsafe/custom");
      expect(text).toContain("not a sandbox");
      typeText(screen, "hidden");
      screen.handleInput?.(" ");
      expect(screen.render(100).join("\n")).toContain("[ ] hidden");
      for (let i = 0; i < "hidden".length; i++) screen.handleInput?.("\x7f");
      typeText(screen, "custom_write");
      screen.handleInput?.(" ");
      expect(screen.render(100).join("\n")).toContain("[x] custom_write");
      screen.handleInput?.("\r");
    },
    cancel,
  ]);
  let saves = 0;
  await configureSettings(
    api([
      { name: "read", description: "Read files", exposure: "direct" },
      { name: "todo", description: "Update tasks", exposure: "direct" },
      {
        name: "ask_user_question",
        description: "Ask questions",
        exposure: "model-only",
      },
      { name: "bash", description: "Run commands", exposure: "direct" },
      {
        name: "custom_read",
        description: "Read custom data",
        exposure: "codemode",
        annotations: { readOnlyHint: true },
      },
      {
        name: "deferred_read",
        description: "Read deferred data",
        exposure: "deferred",
        annotations: { readOnlyHint: true },
      },
      {
        name: "codemode_tool",
        description: "Custom script",
        exposure: "codemode",
      },
      {
        name: "custom_write",
        description: "Write custom data",
        exposure: "direct",
      },
      {
        name: "hidden",
        description: "Unavailable tool",
        exposure: "hidden",
        annotations: { readOnlyHint: true },
      },
    ]),
    h.ctx,
    settings,
    async () => {
      saves++;
    },
  );
  expect(settings.tools).toEqual({ hidden: false, custom_write: true });
  expect(saves).toBe(1);
});

test("cancelled tool edits preserve overrides and wide tool labels remain narrow-safe", async () => {
  const settings = defaultSettings();
  settings.tools.unregistered = true;
  const h = harness([
    select("tools"),
    (screen) => {
      for (const width of [1, 2, 3, 8, 20, 40, 80]) {
        for (const line of screen.render(width))
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      screen.handleInput?.(" ");
      cancel(screen);
    },
    cancel,
  ]);
  await configureSettings(
    api([
      {
        name: "資料検索工具",
        exposure: "direct",
        description: "Search data",
        annotations: { readOnlyHint: true },
      },
    ]),
    h.ctx,
    settings,
    async () => {
      throw new Error("must not save");
    },
  );
  expect(settings.tools).toEqual({ unregistered: true });
});

test("all thinking levels and available provider/id model choices can be saved", async () => {
  const settings = defaultSettings();
  const h = harness([
    select("planningThinking"),
    select("max"),
    select("implementationThinking"),
    (screen) => {
      const text = screen.render(240).join("\n");
      for (const value of ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"])
        expect(text).toContain(value);
      select("off")(screen);
    },
    select("implementationModel"),
    (screen) => {
      expect(screen.render(240).join("\n")).toContain("vendor/model/one");
      expect(screen.render(240).join("\n")).toContain("inherit");
      select("vendor/model/one")(screen);
    },
    cancel,
  ]);
  let saves = 0;
  await configureSettings(api(), h.ctx, settings, async () => {
    saves++;
  });
  expect(settings.planningThinking).toBe("max");
  expect(settings.implementationThinking).toBe("off");
  expect(settings.implementationModel).toBe("vendor/model/one");
  expect(saves).toBe(3);
});

test("bash editor trims/deduplicates lines, supports empty lists and rejects invalid shell prefixes", async () => {
  const settings = defaultSettings();
  const original = [...settings.bashWhitelist];
  const h = harness([
    select("bashWhitelist"),
    select("bashWhitelist"),
    select("bashWhitelist"),
    cancel,
  ]);
  h.editorResults.push("cat > output", " pwd \r\n\n git --no-pager status\n pwd ", "\n  \n");
  const saved: string[][] = [];
  await configureSettings(api(), h.ctx, settings, async () => {
    saved.push([...settings.bashWhitelist]);
  });
  expect(h.editorCalls[0].prefill).toBe(original.join("\n"));
  expect(h.editorCalls[0].title).toContain("not a sandbox");
  expect(saved).toEqual([["pwd", "git --no-pager status"], []]);
  expect(h.notifications.some((notification) => notification.type === "error")).toBe(true);
});

test("cancelled subdialogs do not save, and failed saves restore the previous in-memory setting", async () => {
  const settings = defaultSettings();
  const h = harness([
    select("bashWhitelist"),
    select("planningThinking"),
    cancel,
    select("implementationThinking"),
    select("high"),
    cancel,
  ]);
  h.editorResults.push(undefined);
  let saves = 0;
  await configureSettings(api(), h.ctx, settings, async () => {
    saves++;
    throw new Error("disk full");
  });
  expect(settings).toEqual(defaultSettings());
  expect(saves).toBe(1);
  expect(h.notifications.at(-1)?.message).toContain("Change reverted");
});

test("RPC uses supported selects/editor, with a notification instead of custom tool checkboxes", async () => {
  const h = harness([], "rpc");
  h.rpcChoices.push((options) => options[2]);
  expect(await chooseAction(h.ctx)).toBe("fresh");
  const settings = defaultSettings();
  h.rpcChoices.push(
    (options) => options[0],
    (options) => options[1],
    () => undefined,
  );
  h.editorResults.push("pwd");
  await configureSettings(api(), h.ctx, settings, async () => {});
  expect(settings.bashWhitelist).toEqual(["pwd"]);
  expect(
    h.notifications.some((notification) =>
      notification.message.includes("Tool checkboxes require TUI"),
    ),
  ).toBe(true);
});

for (const mode of ["json", "print"] as const) {
  test(`${mode} returns without invoking dialogs or custom UI`, async () => {
    const h = harness([], mode);
    expect(await chooseAction(h.ctx)).toBeUndefined();
    await configureSettings(api(), h.ctx, defaultSettings(), async () => {
      throw new Error("must not save");
    });
    expect(h.notifications).toHaveLength(2);
  });
}
