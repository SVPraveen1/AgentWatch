//go:build !windows

package main

import "errors"

func listProcesses() ([]ProcessInfo, error) {
	return nil, errors.New("win32 helper only supported on Windows")
}

func listTcpListeners() ([]TcpListener, error) {
	return nil, errors.New("win32 helper only supported on Windows")
}

func resolveTerminalForPid(_ uint32) TerminalFocusResult {
	return TerminalFocusResult{OK: false, Error: "Win32 terminal resolution only supported on Windows."}
}

func focusTerminalWindow(_ uint32, _ string) TerminalFocusResult {
	return TerminalFocusResult{OK: false, Error: "Win32 terminal focus only supported on Windows."}
}

func isForegroundFullscreen() bool {
	return false
}

func killProcessTree(_ uint32) error {
	return errors.New("win32 kill-tree only supported on Windows")
}
