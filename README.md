# Pi Extensions

A bundled Pi package containing three custom extensions:

- **Plan Mode** — an approval-based planning workflow with configurable tools and implementation settings.
- **Notify** — native terminal notifications when Pi needs input or a run settles.
- **Titlebar Spinner** — session and agent status in the terminal title.

## Install

Install the package from GitHub:

```sh
pi install git:github.com/caturbgs/pi-extensions
```

This installs and loads all three extensions as one package. Restart Pi or run `/reload` after installation. The package source is also recorded in the linked `dev-config/agents/pi/settings.json` so the configuration and installed package stay aligned.

Plan Mode preferences remain separate from the package source. In the dev-config setup, `~/.pi/agent/plan-mode-settings.json` is a symlink to `dev-config/agents/pi/plan-mode-settings.json`; `/plan settings` updates that tracked file.

## Development

Use Bun for tests and scripts, and make the Pi host packages available to the module resolver. Pi provides these packages at runtime; they are peer dependencies and are not bundled into this package.

```sh
bun install
bun run test
bun run check
bun run format:check
```

Plan Mode's UI tests run separately from its workflow tests to prevent mock leakage. Its `PLAN.md` and `state/` recovery data are local generated files and are gitignored.
