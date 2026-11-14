!include "LogicLib.nsh"

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

; 安装/卸载前结束正在运行的 Denia。
;
; 旧进程占着 Denia.exe 和内置服务的端口,不先退出就会覆盖失败或新实例起不来。
; 先不带 /F 发关闭消息,让应用自己收尾浏览器、MCP 子进程和端口;等不到再强杀。
; 强制结束只按映像名匹配,不带 /T:应用拉起更新安装器时安装器是它的子进程,
; /T 会连安装器自己一起结束。taskkill 的 128 表示没有匹配的进程。
!macro customCheckAppRunning
  DetailPrint "正在关闭正在运行的 ${PRODUCT_NAME}…"
  nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  ${If} $0 == 128
    ; 没有实例在运行,直接继续
  ${Else}
    Sleep 2500
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $0
    Sleep 800
    ${If} $0 != 0
    ${AndIf} $0 != 128
      MessageBox MB_OK|MB_ICONSTOP "$(appCannotBeClosed)"
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; 目录选择页只在全新安装时出现。
;
; 覆盖安装和应用内更新已经有确定的安装位置,再让用户选一遍没有意义。
; electron-builder 的 allowToChangeInstallationDirectory 是编译期开关,
; 做不到按状态显示,所以关掉它,在安装目录页的位置自己插入一页。
!ifndef BUILD_UNINSTALLER
  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipDirIfInstalled
    !insertmacro MUI_PAGE_DIRECTORY
    !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
      !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !endif

    ; 选中的是父目录,补一层应用名子目录,与默认安装位置保持一致
    !define MUI_PAGE_CUSTOMFUNCTION_PRE EnsureAppSubfolder
    Function EnsureAppSubfolder
      IfFileExists "$INSTDIR\${PRODUCT_FILENAME}.exe" 0 +2
        Return
      StrLen $0 "${APP_FILENAME}"
      StrCpy $1 $INSTDIR "" -$0
      ${If} $1 != "${APP_FILENAME}"
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
    FunctionEnd
  !macroend

  Function SkipDirIfInstalled
    ReadRegStr $0 HKCU "Software\${APP_GUID}" InstallLocation
    ${If} $0 == ""
      ReadRegStr $0 HKLM "Software\${APP_GUID}" InstallLocation
    ${EndIf}
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\${PRODUCT_FILENAME}.exe"
      StrCpy $INSTDIR $0
      Abort
    ${EndIf}
  FunctionEnd
!endif
