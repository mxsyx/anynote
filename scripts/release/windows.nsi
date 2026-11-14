Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
Name "Anynote"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Anynote"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!ifdef SIGN_UNINSTALLER
  !uninstfinalize '"${PYTHON}" "${SIGN_SCRIPT}" sign-file "%1" --target win-x64' = 0
!endif
!define APP_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\5a9cd370-55e7-58e4-80f8-f6e95f4278bc"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Var LockHandle
Var Moved

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This package requires Windows x64."
    Abort
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\app.anynote.desktop.install") p .r0 ?e'
  Pop $1
  StrCpy $LockHandle $0
  StrCmp $1 183 0 +3
    MessageBox MB_ICONSTOP "Another Anynote installation is running."
    Abort
FunctionEnd

Section "Install"
  StrCpy $Moved 0
  IfFileExists "$INSTDIR.previous\*" blocked
  IfFileExists "$INSTDIR.candidate\*" blocked
  IfFileExists "$INSTDIR\*" 0 empty_destination
  IfFileExists "$INSTDIR\anynote-desktop.exe" empty_destination blocked
empty_destination:
  CreateDirectory "$INSTDIR.candidate"
  SetOutPath "$INSTDIR.candidate"
  ClearErrors
  File /r "${PAYLOAD}\*"
  IfErrors failed
  WriteUninstaller "$INSTDIR.candidate\Uninstall.exe"
  IfErrors failed
  ClearErrors
  ExecWait '"$INSTDIR.candidate\anynote-desktop.exe" --release-check' $0
  IfErrors failed
  StrCmp $0 0 0 failed
  ; Renaming the whole prior installation preserves files for rollback. A locked
  ; executable makes this fail before the candidate replaces the current path.
  IfFileExists "$INSTDIR\*" 0 activate
  ClearErrors
  Rename "$INSTDIR" "$INSTDIR.previous"
  IfErrors failed
  StrCpy $Moved 1
activate:
  SetOutPath "$TEMP"
  ClearErrors
  Rename "$INSTDIR.candidate" "$INSTDIR"
  IfErrors restore
  ClearErrors
  ExecWait '"$INSTDIR\anynote-desktop.exe" --release-check' $0
  IfErrors undo
  StrCmp $0 0 0 undo
  SetOutPath "$INSTDIR"
  CreateShortcut "$SMPROGRAMS\Anynote.lnk" "$INSTDIR\anynote-desktop.exe"
  WriteRegStr HKCU "${APP_KEY}" "DisplayName" "Anynote"
  WriteRegStr HKCU "${APP_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${APP_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${APP_KEY}" "InstallLocation" "$INSTDIR"
  Goto done
undo:
  SetOutPath "$TEMP"
  Rename "$INSTDIR" "$INSTDIR.candidate"
  IfErrors recovery
restore:
  StrCmp $Moved 1 0 failed
  ClearErrors
  Rename "$INSTDIR.previous" "$INSTDIR"
  IfErrors recovery
failed:
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR.candidate"
  SetErrorLevel 1
  MessageBox MB_ICONSTOP "Installation failed. The previous application and all user data were preserved."
  Abort
blocked:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP "A previous or interrupted installation is retained. Close Anynote and archive the sibling .previous/.candidate directory before retrying."
  Abort
recovery:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP "Rollback could not rename a locked directory. Close Anynote and restore the retained .previous directory manually. User data was not changed."
  Abort
done:
SectionEnd

Section "Uninstall"
  ; User data and externally registered notebooks are outside this directory.
  Delete "$SMPROGRAMS\Anynote.lnk"
  DeleteRegKey HKCU "${APP_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
