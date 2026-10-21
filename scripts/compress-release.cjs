const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const releaseDir = path.resolve(__dirname, '..', 'release')
if (!fs.existsSync(releaseDir)) {
  console.log('[compress-release] El directorio release no existe.')
  process.exit(0)
}

const exeFiles = fs.readdirSync(releaseDir).filter((file) => file.endsWith('.exe'))
if (exeFiles.length === 0) {
  console.log('[compress-release] No hay archivos .exe para comprimir en release.')
  process.exit(0)
}

for (const exeFile of exeFiles) {
  const exePath = path.join(releaseDir, exeFile)
  const zipName = exeFile.replace(/\.exe$/i, '.zip')
  const zipPath = path.join(releaseDir, zipName)

  console.log(`[compress-release] Comprimiendo ${exeFile} -> ${zipName}...`)
  try {
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${exePath}' -DestinationPath '${zipPath}' -Force"`, {
      stdio: 'inherit',
    })
    fs.unlinkSync(exePath)
    console.log(`[compress-release] ✓ ${zipName} creado exitosamente y ${exeFile} eliminado de release.`)
  } catch (err) {
    console.error(`[compress-release] Error al comprimir ${exeFile}:`, err.message)
  }
}
