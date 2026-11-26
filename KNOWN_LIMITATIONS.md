# Known Limitations (v1)

This document lists platform constraints, upstream agent limitations, and verification scope boundaries for **AgentWatch v1**. Every item below implements the closest graceful fallback and is surfaced in the UI where relevant.

---

## 1. OpenAI Codex CLI Permission Interception & Windows Hooks

- **Behavior in Codex:** Upstream Codex CLI (`openai/codex`) historically relies on top-level `notify` (`agent-turn-complete`) in `config.toml` and gates lifecycle hooks (`hooks.json`) behind `[features] hooks = true` (previously `codex_hooks = true`) and interactive `/hooks` trust review. On Windows, `codex-rs/hooks` (`command_runner.rs`) has documented upstream caveats around nested shell quoting with paths containing spaces (`cmd.exe /C` / `pwsh -Command`) and `PreToolUse` scope (`Bash`, `apply_patch`, MCP tools).
- **Graceful fallback in AgentWatch:**
  - `Connect` patches both `config.toml` (`notify` + `[features] hooks = true`) and `hooks.json`.
  - A background `CodexRolloutWatcher` incrementally tails `%CODEX_HOME%\sessions\YYYY\MM\DD\rollout-*.jsonl` so session starts, errors, and approval requests appear even when hooks are disabled or untrusted.
  - When a Codex permission request arrives via `notify` (`approval-requested`) or rollout logs (`exec_approval_request` / `apply_patch_approval_request`) and cannot be answered interactively, AgentWatch shows a **read-only "Needs approval in terminal"** card with an **Open Terminal** button and labels the limitation on the Codex connection card.

---

## 2. Claude Code 5-Hour & Weekly Usage Percentage

- **Documented local source:** Claude Code only emits `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`) to a configured `statusLine` command via `stdin` (for Claude Pro/Max/Team subscription accounts after the first API response, and not for raw API key accounts). Calling Anthropic's undocumented OAuth usage endpoint requires outbound network access, which violates AgentWatch v1's zero-outbound-network rule.
- **Graceful fallback in AgentWatch:**
  - AgentWatch never silently overwrites the user's `statusLine`. Users can opt into the **StatusLine bridge** in the Usage tab (which chains any pre-existing `statusLine` command and caches `rate_limits` locally).
  - Without a live `statusLine` snapshot, `ClaudeUsageProvider` falls back to rolling 5-hour and 7-day token sums parsed from `%USERPROFILE%\.claude\projects\**\*.jsonl`, clearly labeled **"estimated"**, showing `"—"` for percentages unless the user configures manual token limits in Usage settings.

---

## 3. Windows Terminal Tab Focus

- **Behavior:** `agentwatch-win32.exe focus-terminal` walks the process tree from the session PID up to the nearest visible window (`WindowsTerminal.exe`, `powershell.exe`, `pwsh.exe`, `cmd.exe`, `Code.exe`) and brings it to the foreground using `AttachThreadInput` + `SetForegroundWindow`.
- **Limitation:** Focusing a *specific tab* inside a multi-tab Windows Terminal or VS Code window is not exposed by stable Win32 APIs; focusing the host window itself is used. If no window handle exists, AgentWatch surfaces a clear UI notice instead of failing silently.

---

## 4. Windows Subsystem for Linux (WSL)

- **Behavior:** `PathResolver` supports pointing config and log directories at `\\wsl$\<distro>\home\<user>\...` when WSL mode is enabled in Settings.
- **Limitation:** v1 targets **native Windows** agents primarily. Process-tree dev-server tracking (`CreateToolhelp32Snapshot` / `GetExtendedTcpTable`) and `AttachThreadInput` terminal focusing inspect Win32 processes, not Linux PIDs inside the WSL VM.

---

## 5. Build Host vs. Target Verification Scope

- **Build environment:** This repository was built and verified on **macOS (`darwin/arm64`)**, with `agentwatch-hook.exe` and `agentwatch-win32.exe` cross-compiled via Go (`windows/amd64` and `windows/arm64`).
- **What was tested directly on this host:** TypeScript compilation, Vite renderer build, Electron main bundle, Go binary cross-compilation (`windows/amd64`, `windows/arm64`), Go unit tests, and Vitest unit/integration tests (settings, Claude & Codex config round-trips, TOML comment preservation, FIFO permission queue + destructive command safety guard, Tier 1/2/3 summaries & secret redaction, incremental JSONL token analytics + usage providers, mocked dev-server tracking, mascot mood state machine, zero-outbound-network source check, WSL/multi-monitor math, and live path-with-spaces Go hook execution against `LocalServer`).
- **Requires live Windows 10/11 verification:** Running the NSIS `.exe` installer/uninstaller (`build/installer.nsh`), live Win32 `AttachThreadInput` window focusing, `WS_EX_NOACTIVATE` overlay focus preservation across Windows mixed-DPI monitors, Windows DPAPI `safeStorage`, and live `GetExtendedTcpTable` dev-server inspection.

---

## 6. Deferred Features (v1)

- **Dollar cost & billing UI:** `CostProvider` (`NullCostProvider`) always returns `null` and `FEATURE_FLAGS.showCost` is locked to `false`.
- **Tier 3 LLM summarizer:** Interface (`LlmSummarizer`) and disabled stub (`DisabledLlmSummarizerStub`) are present; disabled in v1.
- **Auto-updates & code signing:** Update checker is a local offline stub; Authenticode signing hooks are documented in `electron-builder.yml`.
