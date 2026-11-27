' Open claclaw: if it is not running, start it in the background first, then open it in the browser.
' The desktop / Start menu shortcut "claclaw" (made by install\install-win.ps1) runs this with wscript.
' Usage: wscript open-claclaw.vbs [port]   (default 8787)
' Kept ASCII-only on purpose: WSH reads .vbs files in the ANSI code page unless they are UTF-16.
Option Explicit
Dim sh, fso, root, port, url, boot, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
port = "8787"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)
url = "http://127.0.0.1:" & port & "/"

If Not IsUp(url & "login") Then
  ' Start it the same way as at logon (Startup\claclaw.vbs, written by claclaw itself); otherwise run the supervisor directly
  boot = sh.SpecialFolders("Startup") & "\claclaw.vbs"
  If fso.FileExists(boot) Then
    sh.Run "wscript.exe """ & boot & """", 0, False
  Else
    sh.CurrentDirectory = root
    sh.Run "node tools\win-serve.mjs --port " & port, 0, False
  End If
  For i = 1 To 60
    WScript.Sleep 500
    If IsUp(url & "login") Then Exit For
  Next
End If
sh.Run url

Function IsUp(u)
  Dim x
  IsUp = False
  On Error Resume Next
  Set x = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  x.setTimeouts 1000, 1000, 1000, 2000
  x.open "GET", u, False
  x.send
  If Err.Number = 0 Then IsUp = (x.status = 200)
  On Error GoTo 0
End Function
