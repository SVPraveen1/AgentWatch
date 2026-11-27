package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const appName = "AgentWatch"
const fastTimeout = 300 * time.Millisecond
const dialTimeout = 250 * time.Millisecond
const defaultPermissionWait = 325 * time.Second

type ServerInfo struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
	Token   string `json:"token"`
	PID     int    `json:"pid"`
}

type HookEnvelope struct {
	Agent      string          `json:"agent"`
	HookEvent  string          `json:"hookEvent,omitempty"`
	Payload    json.RawMessage `json:"payload"`
	ArgPayload string          `json:"argPayload,omitempty"`
	PPID       int             `json:"ppid"`
	PID        int             `json:"pid"`
	SentAt     int64           `json:"sentAt"`
}

type HookResponse struct {
	OK               bool            `json:"ok"`
	StdoutJSON       json.RawMessage `json:"stdoutJson,omitempty"`
	ExitCode         int             `json:"exitCode,omitempty"`
	PermissionStatus string          `json:"permissionStatus,omitempty"`
}

func resolveDataDir() string {
	if override := os.Getenv("AGENTWATCH_DATA_DIR"); override != "" {
		return override
	}
	if runtime.GOOS == "windows" {
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, appName)
		}
		if home := os.Getenv("USERPROFILE"); home != "" {
			return filepath.Join(home, "AppData", "Roaming", appName)
		}
	}
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", appName)
	}
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, appName)
	}
	return filepath.Join(home, ".config", appName)
}

func readServerInfo(dataDir string) (*ServerInfo, error) {
	p := filepath.Join(dataDir, "server.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var info ServerInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, err
	}
	if info.Address == "" || info.Port <= 0 || info.Token == "" {
		return nil, os.ErrInvalid
	}
	return &info, nil
}

func readStdinNonBlocking(maxBytes int64) []byte {
	stat, err := os.Stdin.Stat()
	if err != nil {
		return nil
	}
	// If stdin is a TTY with no piped input, don't hang waiting for EOF.
	if (stat.Mode() & os.ModeCharDevice) != 0 {
		return nil
	}
	type readResult struct {
		data []byte
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, maxBytes))
		ch <- readResult{data: data, err: err}
	}()

	select {
	case res := <-ch:
		if res.err != nil {
			return nil
		}
		return bytes.TrimSpace(res.data)
	case <-time.After(150 * time.Millisecond):
		// Non-blocking timeout guard: prevents hanging agent sessions if pipe is left unclosed
		return nil
	}
}

func isBlockingHookEvent(hookEvent string, payload []byte, waitFlag bool) bool {
	if waitFlag {
		return true
	}
	if strings.EqualFold(hookEvent, "PermissionRequest") {
		return true
	}
	var obj map[string]any
	if len(payload) > 0 && json.Unmarshal(payload, &obj) == nil {
		if name, ok := obj["hook_event_name"].(string); ok && strings.EqualFold(name, "PermissionRequest") {
			return true
		}
	}
	return false
}

func sendToCore(info *ServerInfo, env HookEnvelope, totalTimeout time.Duration) (*HookResponse, error) {
	body, err := json.Marshal(env)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), totalTimeout)
	defer cancel()

	client := &http.Client{
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout: dialTimeout,
			}).DialContext,
		},
	}

	url := "http://" + net.JoinHostPort(info.Address, intToString(info.Port)) + "/events"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-AgentWatch-Token", info.Token)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, os.ErrPermission
	}
	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var out HookResponse
	if len(bytes.TrimSpace(respBytes)) == 0 {
		return &HookResponse{OK: true}, nil
	}
	if err := json.Unmarshal(respBytes, &out); err != nil {
		return &HookResponse{OK: true}, nil
	}
	return &out, nil
}

func intToString(n int) string {
	if n == 0 {
		return "0"
	}
	var digits [20]byte
	i := len(digits)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		digits[i] = byte('0' + (n % 10))
		n /= 10
	}
	if neg {
		i--
		digits[i] = '-'
	}
	return string(digits[i:])
}

func run(args []string, stdinBytes []byte, stdout io.Writer) int {
	fs := flag.NewFlagSet("agentwatch-hook", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	agent := fs.String("agent", "claude_code", "agent identifier")
	hookEvent := fs.String("event", "", "optional hook event override")
	wait := fs.Bool("wait", false, "wait for blocking response")
	waitSec := fs.Int("wait-seconds", int(defaultPermissionWait.Seconds()), "permission wait timeout")
	cacheFile := fs.String("cache-file", "", "cache file path for StatusLine rate_limits")
	chainCmd := fs.String("chain-statusline", "", "original user statusLine command to chain")
	_ = fs.Parse(args)

	if strings.EqualFold(*hookEvent, "StatusLine") {
		return handleStatusLine(stdinBytes, *cacheFile, *chainCmd, stdout)
	}

	rest := fs.Args()
	argPayload := ""
	if len(rest) > 0 {
		argPayload = rest[0]
	}

	payload := bytes.TrimSpace(stdinBytes)
	if len(payload) == 0 && argPayload != "" && strings.HasPrefix(strings.TrimSpace(argPayload), "{") {
		payload = []byte(argPayload)
	}
	if len(payload) == 0 {
		payload = []byte("{}")
	}
	if !json.Valid(payload) {
		wrapped, _ := json.Marshal(map[string]string{"raw": string(payload)})
		payload = wrapped
	}

	dataDir := resolveDataDir()
	info, err := readServerInfo(dataDir)
	if err != nil {
		// Fail-safe: app not running -> exit quietly with no decision.
		return 0
	}

	timeout := fastTimeout
	if isBlockingHookEvent(*hookEvent, payload, *wait) {
		timeout = time.Duration(*waitSec) * time.Second
		if timeout < fastTimeout {
			timeout = fastTimeout
		}
	}

	env := HookEnvelope{
		Agent:      *agent,
		HookEvent:  *hookEvent,
		Payload:    payload,
		ArgPayload: argPayload,
		PPID:       os.Getppid(),
		PID:        os.Getpid(),
		SentAt:     time.Now().UnixMilli(),
	}

	resp, err := sendToCore(info, env, timeout)
	if err != nil || resp == nil {
		// Fail-safe: timeout/connection error -> exit quietly with no decision.
		return 0
	}

	if len(resp.StdoutJSON) > 0 && string(resp.StdoutJSON) != "null" {
		_, _ = stdout.Write(resp.StdoutJSON)
		_, _ = stdout.Write([]byte("\n"))
	}
	return resp.ExitCode
}

func handleStatusLine(stdinBytes []byte, cacheFile, chainCmd string, stdout io.Writer) int {
	if cacheFile != "" && len(stdinBytes) > 0 && json.Valid(stdinBytes) {
		var parsed map[string]any
		if json.Unmarshal(stdinBytes, &parsed) == nil {
			if rl, ok := parsed["rate_limits"]; ok && rl != nil {
				_ = os.MkdirAll(filepath.Dir(cacheFile), 0o755)
				payload, _ := json.Marshal(map[string]any{
					"capturedAt":  time.Now().UnixMilli(),
					"rate_limits": rl,
				})
				tmp := cacheFile + ".tmp"
				if os.WriteFile(tmp, payload, 0o600) == nil {
					_ = os.Rename(tmp, cacheFile)
				}
			}
		}
	}
	if chainCmd != "" {
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.Command("cmd.exe", "/C", chainCmd)
		} else {
			cmd = exec.Command("sh", "-c", chainCmd)
		}
		cmd.Stdin = bytes.NewReader(stdinBytes)
		cmd.Stdout = stdout
		_ = cmd.Run()
	}
	return 0
}

func main() {
	stdinBytes := readStdinNonBlocking(4 << 20)
	code := run(os.Args[1:], stdinBytes, os.Stdout)
	os.Exit(code)
}
