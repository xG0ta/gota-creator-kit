Option Explicit

' Inicia el supervisor totalmente oculto. El supervisor solo levanta el motor
' mientras Adobe Premiere Pro está abierto.
Dim shell, fs, base, command
Set fs = CreateObject("Scripting.FileSystemObject")
base = fs.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & base & "\Supervisor.ps1"""
Set shell = CreateObject("WScript.Shell")
shell.Run command, 0, False
