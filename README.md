# AgentWatch

Windows "Agent Notch" desktop app watching **Claude Code** and **Codex** sessions locally — with zero audio, zero accounts, zero telemetry, and zero outbound network requests.

## Architecture

- **Main process (`src/main/`)**: `LocalServer` (`127.0.0.1` loopback + per-install auth token + `Origin` rejection), `SessionStore`, `PermissionManager` (FIFO queue, destructive-command safety guard, conditional global hotkeys), `SummaryPipeline`, `TokenAnalyticsEngine`, `DevServerTracker`, `WindowManager` (non-activating top-center notch overlay, dashboard, tray).
- **Hook & Win32 CLIs (`cmd/`)**:
  - `agentwatch-hook`: standalone Go binary with 300ms fail-safe for normal events and dial-checked long-poll for blocking permissions.
  - `agentwatch-win32`: standalone Go Win32 syscall helper (`CreateToolhelp32Snapshot`, `GetExtendedTcpTable`, `EnumWindows`, `AttachThreadInput`, `GetMonitorInfoW`).
- **Renderer (`src/renderer/`)**: React + Vite overlay notch, 6-tab dashboard, WCAG AA Dark/Light/System themes, original SVG mascot.
- **Dev Simulator (`tools/agentwatch-sim/`)**: emits realistic hook event streams for both Claude Code and Codex.

## Development & Verification

```bash
npm install
npm run typecheck
npm run build
npm test
```

### Run Simulator Against Live App

```bash
node dist-tools/tools/agentwatch-sim/index.js --agent claude_code --scenario demo
node dist-tools/tools/agentwatch-sim/index.js --agent claude_code --scenario permission
node dist-tools/tools/agentwatch-sim/index.js --agent codex --scenario demo
```

### Package for Windows (x64 / arm64 NSIS)

```bash
npm run package:win
```

See [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) for Codex Windows hook fallbacks, Claude StatusLine bridge details, and Windows-host verification items.
