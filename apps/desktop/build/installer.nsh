!include "FileFunc.nsh"

!macro customInstall
  ; Local builds can differ from CI builds with the same version. Keep the
  ; adjacent map with the exact installer NSIS has cached, without a network call.
  !ifdef APP_INSTALLER_STORE_FILE
    ${If} ${FileExists} "$EXEPATH.blockmap"
      Push $R0
      ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R0
      CreateDirectory "$R0"
      CopyFiles /SILENT "$EXEPATH.blockmap" "$R0\current.blockmap"
      Pop $R0
    ${EndIf}
  !endif
!macroend
