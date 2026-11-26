package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestFailSafeWhenServerNotRunning(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("AGENTWATCH_DATA_DIR", tmp)

	start := time.Now()
	var out bytes.Buffer
	code := run([]string{"--agent", "claude_code"}, []byte(`{"hook_event_name":"Stop"}`), &out)
	elapsed := time.Since(start)

	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if out.Len() != 0 {
		t.Fatalf("expected empty stdout, got %q", out.String())
	}
	if elapsed > 200*time.Millisecond {
		t.Fatalf("expected fast fail-safe exit, took %v", elapsed)
	}
}

func TestFailSafeOnSlowServerTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(600 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	host, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)

	tmp := t.TempDir()
	t.Setenv("AGENTWATCH_DATA_DIR", tmp)
	infoBytes, _ := json.Marshal(ServerInfo{Address: host, Port: port, Token: "tok-123", PID: os.Getpid()})
	_ = os.WriteFile(filepath.Join(tmp, "server.json"), infoBytes, 0o600)

	start := time.Now()
	var out bytes.Buffer
	code := run([]string{"--agent", "claude_code"}, []byte(`{"hook_event_name":"PreToolUse"}`), &out)
	elapsed := time.Since(start)

	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if out.Len() != 0 {
		t.Fatalf("expected empty stdout, got %q", out.String())
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("expected ~300ms fail-safe timeout, took %v", elapsed)
	}
}

func TestForwardsTokenAndReturnsStdoutJSON(t *testing.T) {
	var receivedToken string
	var receivedEnv HookEnvelope
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedToken = r.Header.Get("X-AgentWatch-Token")
		_ = json.NewDecoder(r.Body).Decode(&receivedEnv)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"stdoutJson":{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}}`))
	}))
	defer srv.Close()

	host, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)

	tmp := t.TempDir()
	t.Setenv("AGENTWATCH_DATA_DIR", tmp)
	infoBytes, _ := json.Marshal(ServerInfo{Address: host, Port: port, Token: "secret-tok", PID: os.Getpid()})
	_ = os.WriteFile(filepath.Join(tmp, "server.json"), infoBytes, 0o600)

	var out bytes.Buffer
	code := run(
		[]string{"--agent", "claude_code"},
		[]byte(`{"hook_event_name":"PermissionRequest","session_id":"s1","tool_name":"Bash"}`),
		&out,
	)

	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if receivedToken != "secret-tok" {
		t.Fatalf("expected secret-tok header, got %q", receivedToken)
	}
	if receivedEnv.Agent != "claude_code" {
		t.Fatalf("expected claude_code agent, got %q", receivedEnv.Agent)
	}
	if !bytes.Contains(out.Bytes(), []byte(`"behavior":"allow"`)) {
		t.Fatalf("expected decision JSON on stdout, got %q", out.String())
	}
}

func TestAcceptsCodexNotifyArgPayload(t *testing.T) {
	var receivedEnv HookEnvelope
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&receivedEnv)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	host, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)

	tmp := t.TempDir()
	t.Setenv("AGENTWATCH_DATA_DIR", tmp)
	infoBytes, _ := json.Marshal(ServerInfo{Address: host, Port: port, Token: "tok", PID: os.Getpid()})
	_ = os.WriteFile(filepath.Join(tmp, "server.json"), infoBytes, 0o600)

	var out bytes.Buffer
	code := run(
		[]string{"--agent", "codex", "--event", "notify", `{"type":"agent-turn-complete","thread-id":"t1"}`},
		nil,
		&out,
	)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if !bytes.Contains(receivedEnv.Payload, []byte(`agent-turn-complete`)) {
		t.Fatalf("expected notify JSON payload, got %s", string(receivedEnv.Payload))
	}
}
