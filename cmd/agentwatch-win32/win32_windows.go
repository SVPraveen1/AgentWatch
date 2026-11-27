//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	user32                         = syscall.NewLazyDLL("user32.dll")
	iphlpapi                       = syscall.NewLazyDLL("iphlpapi.dll")
	ntdll                          = syscall.NewLazyDLL("ntdll.dll")
	procCreateToolhelp32Snapshot   = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW            = kernel32.NewProc("Process32FirstW")
	procProcess32NextW             = kernel32.NewProc("Process32NextW")
	procGetCurrentThreadId         = kernel32.NewProc("GetCurrentThreadId")
	procOpenProcess                = kernel32.NewProc("OpenProcess")
	procEnumWindows                = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessId   = user32.NewProc("GetWindowThreadProcessId")
	procIsWindow                   = user32.NewProc("IsWindow")
	procIsWindowVisible            = user32.NewProc("IsWindowVisible")
	procIsIconic                   = user32.NewProc("IsIconic")
	procGetWindowTextW             = user32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW       = user32.NewProc("GetWindowTextLengthW")
	procGetClassNameW              = user32.NewProc("GetClassNameW")
	procGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	procSetForegroundWindow        = user32.NewProc("SetForegroundWindow")
	procBringWindowToTop           = user32.NewProc("BringWindowToTop")
	procShowWindow                 = user32.NewProc("ShowWindow")
	procAttachThreadInput          = user32.NewProc("AttachThreadInput")
	procSetFocus                   = user32.NewProc("SetFocus")
	procGetWindowRect              = user32.NewProc("GetWindowRect")
	procMonitorFromWindow          = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW            = user32.NewProc("GetMonitorInfoW")
	procGetExtendedTcpTable        = iphlpapi.NewProc("GetExtendedTcpTable")
	procNtQueryInformationProcess  = ntdll.NewProc("NtQueryInformationProcess")
	procSetProcessDpiAwarenessCtx  = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDPIAware         = user32.NewProc("SetProcessDPIAware")
)

func init() {
	// Enable Per-Monitor V2 DPI awareness (-4) on Windows 10/11, falling back to legacy DPI aware
	if procSetProcessDpiAwarenessCtx.Find() == nil {
		_, _, _ = procSetProcessDpiAwarenessCtx.Call(uintptr(^uintptr(3)))
	} else if procSetProcessDPIAware.Find() == nil {
		_, _, _ = procSetProcessDPIAware.Call()
	}
}

const (
	th32csSnapProcess              = 0x00000002
	maxPath                        = 260
	swRestore                      = 9
	swShow                         = 5
	afInet                         = 2
	afInet6                        = 23
	tcpTableOwnerPidListen         = 3
	tcpStateListen                 = 2
	monitorDefaultNearest          = 2
	processCommandLineInformation = 60
	processQueryLimitedInformation = 0x1000
)

type unicodeString struct {
	Length        uint16
	MaximumLength uint16
	Buffer        *uint16
}

type processEntry32W struct {
	dwSize              uint32
	cntUsage            uint32
	th32ProcessID       uint32
	th32DefaultHeapID   uintptr
	th32ModuleID        uint32
	cntThreads          uint32
	th32ParentProcessID uint32
	pcPriClassBase      int32
	dwFlags             uint32
	szExeFile           [maxPath]uint16
}

type rect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

type monitorInfo struct {
	cbSize    uint32
	rcMonitor rect
	rcWork    rect
	dwFlags   uint32
}

type mibTcpRowOwnerPid struct {
	dwState      uint32
	dwLocalAddr  uint32
	dwLocalPort  uint32
	dwRemoteAddr uint32
	dwRemotePort uint32
	dwOwningPid  uint32
}

type mibTcp6RowOwnerPid struct {
	ucLocalAddr    [16]byte
	dwLocalScopeId uint32
	dwLocalPort    uint32
	ucRemoteAddr   [16]byte
	dwRemoteScope  uint32
	dwRemotePort   uint32
	dwState        uint32
	dwOwningPid    uint32
}

func listProcesses() ([]ProcessInfo, error) {
	snap, _, err := procCreateToolhelp32Snapshot.Call(th32csSnapProcess, 0)
	if snap == uintptr(syscall.InvalidHandle) {
		return nil, err
	}
	defer syscall.CloseHandle(syscall.Handle(snap))

	var entry processEntry32W
	entry.dwSize = uint32(unsafe.Sizeof(entry))
	r1, _, err := procProcess32FirstW.Call(snap, uintptr(unsafe.Pointer(&entry)))
	if r1 == 0 {
		return nil, err
	}

	var out []ProcessInfo
	for {
		out = append(out, ProcessInfo{
			PID:     entry.th32ProcessID,
			PPID:    entry.th32ParentProcessID,
			ExeName: syscall.UTF16ToString(entry.szExeFile[:]),
		})
		entry.dwSize = uint32(unsafe.Sizeof(entry))
		rNext, _, _ := procProcess32NextW.Call(snap, uintptr(unsafe.Pointer(&entry)))
		if rNext == 0 {
			break
		}
	}
	return out, nil
}

func ntohsPort(raw uint32) uint16 {
	var buf [4]byte
	binary.LittleEndian.PutUint32(buf[:], raw)
	return binary.BigEndian.Uint16(buf[:2])
}

func listTcpListeners() ([]TcpListener, error) {
	var listeners []TcpListener
	listeners = append(listeners, queryTcpTable(afInet)...)
	listeners = append(listeners, queryTcpTable(afInet6)...)
	return listeners, nil
}

func queryTcpTable(family uintptr) []TcpListener {
	var size uint32
	_, _, _ = procGetExtendedTcpTable.Call(0, uintptr(unsafe.Pointer(&size)), 0, family, tcpTableOwnerPidListen, 0)
	if size == 0 {
		return nil
	}
	buf := make([]byte, size)
	ret, _, _ := procGetExtendedTcpTable.Call(
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)),
		0,
		family,
		tcpTableOwnerPidListen,
		0,
	)
	if ret != 0 || len(buf) < 4 {
		return nil
	}
	count := *(*uint32)(unsafe.Pointer(&buf[0]))
	var out []TcpListener
	offset := uintptr(4)
	if family == afInet {
		rowSize := unsafe.Sizeof(mibTcpRowOwnerPid{})
		for i := uint32(0); i < count && int(offset+rowSize) <= len(buf); i++ {
			row := (*mibTcpRowOwnerPid)(unsafe.Pointer(&buf[offset]))
			if row.dwState == tcpStateListen {
				var ipBytes [4]byte
				binary.LittleEndian.PutUint32(ipBytes[:], row.dwLocalAddr)
				out = append(out, TcpListener{
					PID:  row.dwOwningPid,
					Port: ntohsPort(row.dwLocalPort),
					Host: net.IP(ipBytes[:]).String(),
				})
			}
			offset += rowSize
		}
	} else {
		rowSize := unsafe.Sizeof(mibTcp6RowOwnerPid{})
		for i := uint32(0); i < count && int(offset+rowSize) <= len(buf); i++ {
			row := (*mibTcp6RowOwnerPid)(unsafe.Pointer(&buf[offset]))
			if row.dwState == tcpStateListen {
				out = append(out, TcpListener{
					PID:  row.dwOwningPid,
					Port: ntohsPort(row.dwLocalPort),
					Host: net.IP(row.ucLocalAddr[:]).String(),
				})
			}
			offset += rowSize
		}
	}
	return out
}

type windowMatch struct {
	hwnd        uintptr
	pid         uint32
	title       string
	processName string
}

func getWindowText(hwnd uintptr) string {
	length, _, _ := procGetWindowTextLengthW.Call(hwnd)
	if length <= 0 {
		return ""
	}
	buf := make([]uint16, length+1)
	_, _, _ = procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(length+1))
	return syscall.UTF16ToString(buf)
}

func getWindowClass(hwnd uintptr) string {
	buf := make([]uint16, 128)
	_, _, _ = procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf)
}

func findWindowForPids(pidOrder []uint32, procMap map[uint32]ProcessInfo) *windowMatch {
	pidWindows := map[uint32]windowMatch{}
	cb := syscall.NewCallback(func(hwnd uintptr, lparam uintptr) uintptr {
		vis, _, _ := procIsWindowVisible.Call(hwnd)
		if vis == 0 {
			return 1
		}
		var pid uint32
		_, _, _ = procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid == 0 {
			return 1
		}
		title := getWindowText(hwnd)
		if title == "" {
			return 1
		}
		var r rect
		_, _, _ = procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
		if r.Right-r.Left <= 0 || r.Bottom-r.Top <= 0 {
			return 1
		}
		if _, exists := pidWindows[pid]; !exists {
			pidWindows[pid] = windowMatch{
				hwnd:        hwnd,
				pid:         pid,
				title:       title,
				processName: procMap[pid].ExeName,
			}
		}
		return 1
	})
	_, _, _ = procEnumWindows.Call(cb, 0)

	// Prefer well-known terminal/editor hosts first if encountered along ancestry chain.
	for _, pid := range pidOrder {
		if m, ok := pidWindows[pid]; ok {
			return &m
		}
	}
	return nil
}

func buildAncestorChain(startPid uint32) ([]uint32, map[uint32]ProcessInfo, error) {
	procs, err := listProcesses()
	if err != nil {
		return nil, nil, err
	}
	procMap := make(map[uint32]ProcessInfo, len(procs))
	for _, p := range procs {
		procMap[p.PID] = p
	}
	var chain []uint32
	seen := map[uint32]bool{}
	cur := startPid
	for cur != 0 && !seen[cur] {
		seen[cur] = true
		chain = append(chain, cur)
		info, ok := procMap[cur]
		if !ok {
			break
		}
		cur = info.PPID
	}
	return chain, procMap, nil
}

func resolveTerminalForPid(pid uint32) TerminalFocusResult {
	if pid == 0 {
		return TerminalFocusResult{OK: false, Error: "No PID available for this session."}
	}
	chain, procMap, err := buildAncestorChain(pid)
	if err != nil {
		return TerminalFocusResult{OK: false, Error: err.Error()}
	}
	match := findWindowForPids(chain, procMap)
	if match == nil {
		return TerminalFocusResult{OK: false, Error: "No visible terminal window found in process tree."}
	}
	return TerminalFocusResult{
		OK:          true,
		HWND:        fmt.Sprintf("0x%x", match.hwnd),
		PID:         match.pid,
		ProcessName: match.processName,
		Title:       match.title,
	}
}

func focusTerminalWindow(pid uint32, hwndHex string) TerminalFocusResult {
	var targetHwnd uintptr
	var targetPid uint32
	var procName string
	var title string

	if hwndHex != "" {
		clean := strings.TrimPrefix(strings.ToLower(hwndHex), "0x")
		if v, err := strconv.ParseUint(clean, 16, 64); err == nil && v != 0 {
			valid, _, _ := procIsWindow.Call(uintptr(v))
			vis, _, _ := procIsWindowVisible.Call(uintptr(v))
			if valid != 0 && vis != 0 {
				targetHwnd = uintptr(v)
				_, _, _ = procGetWindowThreadProcessId.Call(targetHwnd, uintptr(unsafe.Pointer(&targetPid)))
				title = getWindowText(targetHwnd)
			}
		}
	}

	if targetHwnd == 0 {
		resolved := resolveTerminalForPid(pid)
		if !resolved.OK {
			return resolved
		}
		clean := strings.TrimPrefix(resolved.HWND, "0x")
		v, _ := strconv.ParseUint(clean, 16, 64)
		targetHwnd = uintptr(v)
		targetPid = resolved.PID
		procName = resolved.ProcessName
		title = resolved.Title
	}

	if targetHwnd == 0 {
		return TerminalFocusResult{OK: false, Error: "Could not locate terminal window."}
	}

	iconic, _, _ := procIsIconic.Call(targetHwnd)
	if iconic != 0 {
		_, _, _ = procShowWindow.Call(targetHwnd, swRestore)
	} else {
		_, _, _ = procShowWindow.Call(targetHwnd, swShow)
	}

	fgHwnd, _, _ := procGetForegroundWindow.Call()
	var fgPid uint32
	fgThread, _, _ := procGetWindowThreadProcessId.Call(fgHwnd, uintptr(unsafe.Pointer(&fgPid)))
	targetThread, _, _ := procGetWindowThreadProcessId.Call(targetHwnd, uintptr(unsafe.Pointer(&targetPid)))
	currThread, _, _ := procGetCurrentThreadId.Call()

	attachedFg := false
	attachedTarget := false
	if fgThread != 0 && fgThread != currThread {
		r, _, _ := procAttachThreadInput.Call(currThread, fgThread, 1)
		attachedFg = r != 0
	}
	if targetThread != 0 && targetThread != currThread && targetThread != fgThread {
		r, _, _ := procAttachThreadInput.Call(currThread, targetThread, 1)
		attachedTarget = r != 0
	}

	_, _, _ = procBringWindowToTop.Call(targetHwnd)
	ok, _, _ := procSetForegroundWindow.Call(targetHwnd)
	_, _, _ = procSetFocus.Call(targetHwnd)

	if attachedTarget {
		_, _, _ = procAttachThreadInput.Call(currThread, targetThread, 0)
	}
	if attachedFg {
		_, _, _ = procAttachThreadInput.Call(currThread, fgThread, 0)
	}

	return TerminalFocusResult{
		OK:          ok != 0,
		HWND:        fmt.Sprintf("0x%x", targetHwnd),
		PID:         targetPid,
		ProcessName: procName,
		Title:       title,
		Error:       func() string { if ok == 0 { return "Windows refused foreground focus lock." }; return "" }(),
	}
}

func isForegroundFullscreen() bool {
	fg, _, _ := procGetForegroundWindow.Call()
	if fg == 0 {
		return false
	}
	cls := getWindowClass(fg)
	if cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" {
		return false
	}
	var winRect rect
	r1, _, _ := procGetWindowRect.Call(fg, uintptr(unsafe.Pointer(&winRect)))
	if r1 == 0 {
		return false
	}
	mon, _, _ := procMonitorFromWindow.Call(fg, monitorDefaultNearest)
	if mon == 0 {
		return false
	}
	var mi monitorInfo
	mi.cbSize = uint32(unsafe.Sizeof(mi))
	r2, _, _ := procGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi)))
	if r2 == 0 {
		return false
	}
	return winRect.Left <= mi.rcMonitor.Left &&
		winRect.Top <= mi.rcMonitor.Top &&
		winRect.Right >= mi.rcMonitor.Right &&
		winRect.Bottom >= mi.rcMonitor.Bottom
}

func killProcessTree(pid uint32) error {
	if pid <= 4 {
		return errors.New("invalid or protected system pid")
	}
	cmd := exec.Command("taskkill", "/PID", strconv.FormatUint(uint64(pid), 10), "/T", "/F")
	return cmd.Run()
}

func getCommandLineForPid(pid uint32) string {
	if pid <= 4 {
		return ""
	}
	h, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer syscall.CloseHandle(syscall.Handle(h))

	var needed uint32
	procNtQueryInformationProcess.Call(h, processCommandLineInformation, 0, 0, uintptr(unsafe.Pointer(&needed)))
	if needed == 0 {
		return ""
	}

	buf := make([]byte, needed)
	r, _, _ := procNtQueryInformationProcess.Call(
		h,
		processCommandLineInformation,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
	)
	if r != 0 || len(buf) <= int(unsafe.Sizeof(unicodeString{})) {
		return ""
	}

	us := (*unicodeString)(unsafe.Pointer(&buf[0]))
	if us.Length == 0 || us.Buffer == nil {
		return ""
	}
	charCount := int(us.Length / 2)
	chars := unsafe.Slice(us.Buffer, charCount)
	return syscall.UTF16ToString(chars)
}
