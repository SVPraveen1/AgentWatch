; NSIS custom uninstall hook for AgentWatch
; Offers to cleanly disconnect AgentWatch hooks from Claude Code and Codex user configs before removing binaries.

!macro customUnInstall
  IfSilent +4
    MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to disconnect AgentWatch hooks from Claude Code and Codex configs so they revert cleanly?" IDNO +3
      nsExec::ExecToLog '"$INSTDIR\AgentWatch.exe" --disconnect-hooks'
      Goto +2
  ; Silent uninstall preserves existing configs unless explicitly requested, or disconnects safely:
  nsExec::ExecToLog '"$INSTDIR\AgentWatch.exe" --disconnect-hooks'
!macroend
