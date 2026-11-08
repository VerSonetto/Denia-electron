; Denia 的 AUMID 注册。
;
; Windows 按 AppUserModelID 归属窗口、任务栏按钮和通知。应用进程用的是
; dev.denia.app(见 src/main.ts),这里把同一个 ID 的显示名和图标写进
; 注册表,任务栏/任务管理器才能显示 Denia 而不是 Electron。
!macro customInstall
  WriteRegStr HKCU "Software\Classes\AppUserModelId\dev.denia.app" "DisplayName" "Denia"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\dev.denia.app" "IconUri" "$INSTDIR\Denia.exe"
  ; 0.2.x 用的旧身份,升级后不再需要。
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\dev.denia.electron"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\dev.denia.app"
!macroend