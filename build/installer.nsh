; ==============================================================================
; GraphMap - Script de personalización de instalador NSIS
; Limpieza de caché de Chromium, shaders y código compilado antes de la instalación
; ==============================================================================

!macro customInit
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
  ; Limpieza durante la instalación cuando los procesos previos ya han terminado
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
