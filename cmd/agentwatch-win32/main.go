package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type ProcessInfo struct {
	PID     uint32 `json:"pid"`
	PPID    uint32 `json:"ppid"`
	ExeName string `json:"exeName"`
}

type TcpListener struct {
	PID  uint32 `json:"pid"`
	Port uint16 `json:"port"`
	Host string `json:"host"`
}

type TerminalFocusResult struct {
	OK          bool   `json:"ok"`
	HWND        string `json:"hwnd,omitempty"`
	PID         uint32 `json:"pid,omitempty"`
	ProcessName string `json:"processName,omitempty"`
	Title       string `json:"title,omitempty"`
	Error       string `json:"error,omitempty"`
}

type FullscreenResult struct {
	Fullscreen bool `json:"fullscreen"`
}

func writeJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "json error: %v\n", err)
		os.Exit(1)
	}
	os.Stdout.Write(b)
	os.Stdout.Write([]byte("\n"))
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: agentwatch-win32 <processes|tcp-listeners|resolve-terminal|focus-terminal|is-fullscreen|kill-tree>")
		os.Exit(2)
	}
	sub := os.Args[1]
	args := os.Args[2:]

	switch sub {
	case "processes":
		procs, err := listProcesses()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		writeJSON(procs)
	case "tcp-listeners":
		listeners, err := listTcpListeners()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		writeJSON(listeners)
	case "command-lines":
		fs := flag.NewFlagSet("command-lines", flag.ExitOnError)
		pidsStr := fs.String("pids", "", "comma-separated pids")
		_ = fs.Parse(args)
		res := make(map[string]string)
		for _, s := range strings.Split(*pidsStr, ",") {
			s = strings.TrimSpace(s)
			if p, err := strconv.ParseUint(s, 10, 32); err == nil && p > 4 {
				if cmd := getCommandLineForPid(uint32(p)); cmd != "" {
					res[s] = cmd
				}
			}
		}
		writeJSON(res)
	case "resolve-terminal":
		fs := flag.NewFlagSet("resolve-terminal", flag.ExitOnError)
		pid := fs.Uint("pid", 0, "starting pid")
		_ = fs.Parse(args)
		writeJSON(resolveTerminalForPid(uint32(*pid)))
	case "focus-terminal":
		fs := flag.NewFlagSet("focus-terminal", flag.ExitOnError)
		pid := fs.Uint("pid", 0, "starting pid")
		hwnd := fs.String("hwnd", "", "saved hwnd hex")
		_ = fs.Parse(args)
		writeJSON(focusTerminalWindow(uint32(*pid), *hwnd))
	case "is-fullscreen":
		writeJSON(FullscreenResult{Fullscreen: isForegroundFullscreen()})
	case "kill-tree":
		fs := flag.NewFlagSet("kill-tree", flag.ExitOnError)
		pid := fs.Uint("pid", 0, "root pid")
		_ = fs.Parse(args)
		if *pid <= 4 {
			writeJSON(map[string]any{"ok": false, "error": "invalid or protected pid"})
			os.Exit(1)
		}
		if err := killProcessTree(uint32(*pid)); err != nil {
			writeJSON(map[string]any{"ok": false, "error": err.Error()})
			os.Exit(1)
		}
		writeJSON(map[string]any{"ok": true})
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n", sub)
		os.Exit(2)
	}
}
