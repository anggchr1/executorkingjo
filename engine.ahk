; Executor Kingjo - engine input (AutoHotkey v1)
; Dibuat berdasarkan D:\ME\game\bb_brutal.ahk
#NoEnv
#SingleInstance Force
#InstallMouseHook
#UseHook
#NoTrayIcon
#MaxThreadsPerHotkey 1
#MaxThreadsBuffer Off
SetBatchLines, -1
ListLines, Off
SendMode, Input
SetMouseDelay, -1
SetDefaultMouseSpeed, 0
Process, Priority,, AboveNormal
DllCall("winmm\timeBeginPeriod", "UInt", 1)
OnExit, Cleanup

global cfgFile  := A_ScriptDir . "\config.ini"
global statFile := A_ScriptDir . "\status.ini"
global QPCFreq  := 0
DllCall("QueryPerformanceFrequency", "Int64*", QPCFreq)

global macros := []
global hkMap := {}
global registered := []
global masterOn := true
global masterKey := "RControl"
global panicKey := "AppsKey"
global paused := false
global stamp := ""
global parentPID := A_Args.Length() ? A_Args[1] : 0

LoadConfig()
Apply()
FileGetTime, stamp, %cfgFile%, M
SetTimer, Watch, 250
return

; ---------- konfigurasi ----------

LoadConfig() {
    global
    empty := ""
    IniRead, masterKey, %cfgFile%, app, master, RControl
    IniRead, panicKey,  %cfgFile%, app, panic, AppsKey
    IniRead, en,        %cfgFile%, app, enabled, 1
    IniRead, pa,        %cfgFile%, app, paused, 0
    IniRead, count,     %cfgFile%, app, count, 0
    masterOn := en = "1"
    paused   := pa = "1"
    macros := []
    Loop, %count%
    {
        s := "m" . A_Index
        IniRead, trg, %cfgFile%, %s%, trigger, %empty%
        IniRead, md,  %cfgFile%, %s%, mode, hold
        IniRead, ac,  %cfgFile%, %s%, action, mouse
        IniRead, vl,  %cfgFile%, %s%, value, left
        IniRead, cp,  %cfgFile%, %s%, cps, 0
        IniRead, en2, %cfgFile%, %s%, enabled, 1
        m := {}
        m.id      := A_Index
        m.trigger := trg
        m.mode    := md
        m.action  := ac
        m.value   := vl
        m.cps     := cp + 0
        m.enabled := en2 = "1"
        m.delay   := m.cps > 0 ? Round(1000 / m.cps) - 1 : 0
        if (m.delay < 1)
            m.delay := 1
        m.running := false
        if (m.trigger != "")
            macros.Push(m)
    }
}

Apply() {
    global
    for i, hk in registered
        Hotkey, %hk%, , Off
    registered := []
    hkMap := {}
    if (masterKey != "")
        Reg(masterKey, "OnMaster")
    if (panicKey != "")
        Reg(panicKey, "OnPanic")
    if (masterOn && !paused) {
        for i, m in macros {
            if (!m.enabled || m.trigger = "")
                continue
            hk := "$*" . m.trigger
            Hotkey, %hk%, OnMacro, On
            registered.Push(hk)
            ; Simpan pakai nama trigger tanpa $*, agar cocok dengan A_ThisHotkey
            hkMap[Lower(m.trigger)] := m
        }
    }
    WriteStatus()
}

Reg(key, label) {
    global registered
    hk := "$*" . key
    Hotkey, %hk%, %label%, On
    registered.Push(hk)
}

WriteStatus() {
    global
    if FileExist(statFile)
        FileDelete, %statFile%
    IniWrite, % masterOn ? 1 : 0, %statFile%, app, enabled
    for i, m in macros
        IniWrite, % m.running ? 1 : 0, %statFile%, % "m" . m.id, running
}

SaveEnabled() {
    global stamp
    IniWrite, % masterOn ? 1 : 0, %cfgFile%, app, enabled
    FileGetTime, stamp, %cfgFile%, M
}

RemoveDebugTip:
    ToolTip
    return

; ---------- aksi ----------

Lower(s) {
    StringLower, s, s
    return s
}

ReleaseAll() {
    Critical, On
    DllCall("mouse_event", "UInt", 0x04, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
    DllCall("mouse_event", "UInt", 0x10, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
    DllCall("mouse_event", "UInt", 0x40, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
    DllCall("mouse_event", "UInt", 0x100, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
    DllCall("mouse_event", "UInt", 0x200, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
    Send, {Ctrl Up}{Shift Up}{Alt Up}{LWin Up}{RWin Up}{AppsKey Up}
    Critical, Off
}

PreciseSleep(ms) {
    global QPCFreq
    DllCall("QueryPerformanceCounter", "Int64*", t0)
    end := t0 + (QPCFreq * ms // 1000)
    Loop {
        DllCall("QueryPerformanceCounter", "Int64*", now)
        remaining := end - now
        if (remaining <= 0)
            break
        if (remaining > QPCFreq * 2 // 1000)
            DllCall("Sleep", "UInt", 1)
    }
}

DoAction(m) {
    Critical, On
    ; Debug: tampilkan apa yang akan dikirim
    t := m.trigger
    a := m.action
    v := m.value
    c := m.cps
    ToolTip, ENGINE DEBUG: trigger=%t% action=%a% value=[%v%] cps=%c%
    SetTimer, RemoveDebugTip, -1500
    if (m.action = "mouse") {
        if (m.value = "right") {
            DllCall("mouse_event", "UInt", 0x08, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
            DllCall("mouse_event", "UInt", 0x10, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
        } else if (m.value = "middle") {
            DllCall("mouse_event", "UInt", 0x40, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
            DllCall("mouse_event", "UInt", 0x80, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
        } else {
            DllCall("mouse_event", "UInt", 0x02, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
            DllCall("mouse_event", "UInt", 0x04, "UInt", 0, "UInt", 0, "UInt", 0, "UPtr", 0)
        }
    } else {
        Send, {%v%}
    }
    Critical, Off
}

StopAll() {
    global macros
    for i, m in macros
        m.running := false
    ReleaseAll()
}

; ---------- hotkey ----------

OnMacro:
    m := hkMap[Lower(A_ThisHotkey)]
    if (!m || !m.enabled || !masterOn)
        return
    if (m.cps <= 0) {
        DoAction(m)
        return
    }
    if (m.mode = "hold") {
        if (m.running)
            return
        m.running := true
        WriteStatus()
        while (GetKeyState(m.trigger, "P")) {
            DoAction(m)
            PreciseSleep(m.delay)
        }
        m.running := false
        WriteStatus()
        return
    }
    if (m.running) {
        m.running := false
        WriteStatus()
        return
    }
    m.running := true
    WriteStatus()
    while (m.running) {
        DoAction(m)
        PreciseSleep(m.delay)
    }
    return

OnMaster:
    masterOn := !masterOn
    StopAll()
    SaveEnabled()
    Apply()
    return

OnPanic:
    StopAll()
    ReleaseAll()
    WriteStatus()
    return

Watch:
    if (parentPID) {
        Process, Exist, %parentPID%
        if (!ErrorLevel) {
            Gosub, Cleanup
            return
        }
    }
    FileGetTime, t, %cfgFile%, M
    if (t = stamp)
        return
    stamp := t
    StopAll()
    LoadConfig()
    Apply()
    return

Cleanup:
    StopAll()
    ReleaseAll()
    ExitApp
    return
