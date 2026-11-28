; 卸载时删掉开机自动启动项（第一次启动时写的 HKCU Run "electron.app.claclaw"），不然留着一个指向已经不存在的程序的启动项
; 更新安装时也会先跑旧版的卸载，那时不删（isUpdated），开机自动启动保持原样
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.claclaw"
  ${endIf}
!macroend
