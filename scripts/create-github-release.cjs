const https = require('https')
const fs = require('fs')
const path = require('path')

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const OWNER = 'duvanCodexx'
const REPO = 'GraphMap'
const TAG = 'v1.0.0'
const ZIP_PATH = path.resolve(__dirname, '..', 'release', 'GraphMap-Setup-1.0.0-x64.zip')

function githubRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        let json
        try {
          json = JSON.parse(body)
        } catch {
          json = body
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(json)
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${typeof json === 'object' ? JSON.stringify(json) : json}`))
        }
      })
    })

    req.on('error', reject)
    if (postData) {
      req.write(postData)
    }
    req.end()
  })
}

async function createOrGetRelease(releaseData) {
  // Primero intentamos buscar si ya existe la release por tag
  try {
    const existing = await githubRequest({
      hostname: 'api.github.com',
      path: `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`,
      method: 'GET',
      headers: {
        'User-Agent': 'GraphMap-Release-Agent',
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    })
    if (existing && existing.id) return existing
  } catch (err) {
    // Si no existe (404), continuamos a crearla
  }

  return await githubRequest(
    {
      hostname: 'api.github.com',
      path: `/repos/${OWNER}/${REPO}/releases`,
      method: 'POST',
      headers: {
        'User-Agent': 'GraphMap-Release-Agent',
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
    },
    JSON.stringify(releaseData),
  )
}

async function deleteAsset(assetId) {
  return await githubRequest({
    hostname: 'api.github.com',
    path: `/repos/${OWNER}/${REPO}/releases/assets/${assetId}`,
    method: 'DELETE',
    headers: {
      'User-Agent': 'GraphMap-Release-Agent',
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  })
}

function uploadReleaseAsset(releaseId, filePath, fileSize) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath)
    const options = {
      hostname: 'uploads.github.com',
      path: `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
      method: 'POST',
      headers: {
        'User-Agent': 'GraphMap-Release-Agent',
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/zip',
        'Content-Length': fileSize,
      },
      timeout: 300000,
    }

    console.log(`Iniciando streaming del asset hacia uploads.github.com...`)
    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve(body)
          }
        } else {
          reject(new Error(`Upload failed with status ${res.statusCode}: ${body}`))
        }
      })
    })

    req.on('error', reject)

    const stream = fs.createReadStream(filePath)
    let uploadedBytes = 0
    let lastPercent = 0

    stream.on('data', (chunk) => {
      uploadedBytes += chunk.length
      const percent = Math.floor((uploadedBytes / fileSize) * 100)
      if (percent >= lastPercent + 10) {
        lastPercent = percent
        console.log(`Progreso de subida: ${percent}% (${(uploadedBytes / 1024 / 1024).toFixed(1)} MB / ${(fileSize / 1024 / 1024).toFixed(1)} MB)`)
      }
    })

    stream.on('error', (err) => {
      req.destroy(err)
      reject(err)
    })

    stream.pipe(req)
  })
}

async function main() {
  try {
    if (!fs.existsSync(ZIP_PATH)) {
      throw new Error(`Archivo ${ZIP_PATH} no encontrado.`)
    }
    const stat = fs.statSync(ZIP_PATH)
    console.log(`Asset localizado: ${path.basename(ZIP_PATH)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`)

    const releaseData = {
      tag_name: TAG,
      target_commitish: 'main',
      name: 'GraphMap v1.0.0',
      body: `## GraphMap v1.0.0 🧠⚡\n\n### 📦 Release Assets\n- **GraphMap-Setup-1.0.0-x64.zip**: Instalador oficial para Windows x64 comprimido en formato .zip (contiene GraphMap-Setup-1.0.0-x64.exe).\n\n### 🚀 Características Principales\n- Segmentación semántica AST funcional de código para agentes de IA.\n- Base vectorial LanceDB on-device ultrarrápida.\n- Demonio silencioso 24/7 en segundo plano (System Tray de Windows).\n- Servidor MCP nativo JSON-RPC 2.0 (mcp-server.cjs).\n- HUD 2D reactivo con live mirroring vía Server-Sent Events (SSE).\n- Memoria de largo plazo persistente para agentes (ahorro >95% en tokens de contexto).`,
      draft: false,
      prerelease: false,
    }

    console.log(`Creando Release ${TAG} en https://github.com/${OWNER}/${REPO}...`)
    const release = await createOrGetRelease(releaseData)
    console.log(`✓ Release creada/confirmada con ID: ${release.id}`)
    console.log(`URL de la Release: ${release.html_url}`)

    if (release.assets && release.assets.length > 0) {
      for (const a of release.assets) {
        if (a.name === path.basename(ZIP_PATH)) {
          console.log(`Limpiando asset duplicado previo: ${a.name}...`)
          await deleteAsset(a.id)
        }
      }
    }

    const uploaded = await uploadReleaseAsset(release.id, ZIP_PATH, stat.size)
    console.log(`✓ Asset ${uploaded.name} publicado exitosamente en GitHub Releases!`)
    console.log(`🔗 Descarga pública directa: ${uploaded.browser_download_url}`)
    console.log(`🔗 Ver Release: ${release.html_url}`)
  } catch (err) {
    console.error('Error al publicar release:', err.message)
    process.exit(1)
  }
}

main()
