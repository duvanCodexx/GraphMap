; ==============================================================================
; GraphMap - Script de personalización de instalador NSIS
; Limpieza de procesos en segundo plano y purga de caché antes de la instalación
; ==============================================================================

!macro customInit
  ; Cerrar de forma segura y completa cualquier proceso residual o en segundo plano (System Tray)
  nsExec::Exec 'taskkill /F /IM GraphMap.exe /T'
  Sleep 500

  ; Limpieza previa al inicio del instalador
  RMDir /r "$APPDATA\GraphMap\Cache"
  RMDir /r "$APPDATA\GraphMap\Code Cache"
  RMDir /r "$APPDATA\GraphMap\GPUCache"
  RMDir /r "$APPDATA\GraphMap\DawnGraphiteCache"
  RMDir /r "$APPDATA\GraphMap\DawnWebGPUCache"
  RMDir /r "$APPDATA\GraphMap\blob_storage"
  RMDir /r "$APPDATA\GraphMap\Session Storage"
  RMDir /r "$APPDATA\GraphMap\Network"
  RMDir /r "$APPDATA\GraphMap\Shared Dictionary"
  RMDir /r "$LOCALAPPDATA\graphmap-updater"
  
  RMDir /r "$APPDATA\graphmap\Cache"
  RMDir /r "$APPDATA\graphmap\Code Cache"
  RMDir /r "$APPDATA\graphmap\GPUCache"
  RMDir /r "$APPDATA\graphmap\DawnGraphiteCache"
  RMDir /r "$APPDATA\graphmap\DawnWebGPUCache"
  RMDir /r "$APPDATA\graphmap\blob_storage"
  RMDir /r "$APPDATA\graphmap\Session Storage"
  RMDir /r "$APPDATA\graphmap\Network"
  RMDir /r "$APPDATA\graphmap\Shared Dictionary"
!macroend

!macro customInstall
  ; Asegurar que los procesos estén completamente cerrados durante la extracción
  nsExec::Exec 'taskkill /F /IM GraphMap.exe /T'
  Sleep 500

  ; Limpieza durante la instalación
  DetailPrint "Limpiando cache previa de interfaz y shaders de GraphMap..."
  RMDir /r "$APPDATA\GraphMap\Cache"
  RMDir /r "$APPDATA\GraphMap\Code Cache"
  RMDir /r "$APPDATA\GraphMap\GPUCache"
  RMDir /r "$APPDATA\GraphMap\DawnGraphiteCache"
  RMDir /r "$APPDATA\GraphMap\DawnWebGPUCache"
  RMDir /r "$APPDATA\GraphMap\blob_storage"
  RMDir /r "$APPDATA\GraphMap\Session Storage"
  RMDir /r "$APPDATA\GraphMap\Network"
  RMDir /r "$APPDATA\GraphMap\Shared Dictionary"
  RMDir /r "$LOCALAPPDATA\graphmap-updater"

  RMDir /r "$APPDATA\graphmap\Cache"
  RMDir /r "$APPDATA\graphmap\Code Cache"
  RMDir /r "$APPDATA\graphmap\GPUCache"
  RMDir /r "$APPDATA\graphmap\DawnGraphiteCache"
  RMDir /r "$APPDATA\graphmap\DawnWebGPUCache"
  RMDir /r "$APPDATA\graphmap\blob_storage"
  RMDir /r "$APPDATA\graphmap\Session Storage"
  RMDir /r "$APPDATA\graphmap\Network"
  RMDir /r "$APPDATA\graphmap\Shared Dictionary"
!macroend
