import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import type { ModelDownloadProgress } from '../types'

// Forzar prioridad IPv4 en el proceso para evitar retardos DNS y timeouts de adaptadores IPv6 en Windows
if (dns && typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first')
}

// Agentes con socket IPv4 estricto y keepAlive
const httpsAgent = new https.Agent({ family: 4, keepAlive: true, timeout: 35000 })
const httpAgent = new http.Agent({ family: 4, keepAlive: true, timeout: 35000 })

export interface ModelFilesConfig {
  repoId: string
  files: string[]
  primaryModelFile: string
}

export const DEFAULT_GEMMA_CONFIG: ModelFilesConfig = {
  // Hugging Face repo oficial con soporte público para EmbeddingGemma ONNX
  repoId: 'onnx-community/embeddinggemma-300m-ONNX',
  files: [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx',
    'onnx/model_quantized.onnx_data',
  ],
  primaryModelFile: 'onnx/model_quantized.onnx',
}

// Tamaño total estimado de los componentes de EmbeddingGemma (~330 MB)
export const ESTIMATED_TOTAL_BYTES = 330_000_000

export class ModelManager {
  private targetDir: string
  private onProgress?: (p: ModelDownloadProgress) => void
  private isDownloading = false
  private lastEmitTime = 0
  private lastEmitBytes = 0

  constructor(targetDir: string, onProgress?: (p: ModelDownloadProgress) => void) {
    this.targetDir = targetDir
    this.onProgress = onProgress
  }

  /**
   * Verifica el estado actual de los archivos del modelo sin descargar nada.
   */
  async checkStatus(resourcesPath?: string): Promise<{
    installed: boolean
    modelDir: string
    filesFound: string[]
    missingFiles: string[]
    totalBytes: number
  }> {
    // 1. Revisar si está preempaquetado en resourcesPath
    if (resourcesPath) {
      const bundledPath = path.join(resourcesPath, 'models', 'embeddinggemma')
      if (await this.isModelComplete(bundledPath)) {
        return {
          installed: true,
          modelDir: bundledPath,
          filesFound: DEFAULT_GEMMA_CONFIG.files,
          missingFiles: [],
          totalBytes: await this.calcDirSize(bundledPath),
        }
      }
    }

    // 2. Revisar almacenamiento local
    const userModelPath = path.join(this.targetDir, 'embeddinggemma')
    const filesFound: string[] = []
    const missingFiles: string[] = []

    for (const file of DEFAULT_GEMMA_CONFIG.files) {
      const fullPath = path.join(userModelPath, file)
      try {
        const stat = await fsPromises.stat(fullPath)
        if (stat.size > 0) {
          filesFound.push(file)
        } else {
          missingFiles.push(file)
        }
      } catch {
        missingFiles.push(file)
      }
    }

    const installed = missingFiles.length === 0
    const totalBytes = installed ? await this.calcDirSize(userModelPath) : 0

    return {
      installed,
      modelDir: userModelPath,
      filesFound,
      missingFiles,
      totalBytes,
    }
  }

  private async calcDirSize(dir: string): Promise<number> {
    let bytes = 0
    try {
      for (const file of DEFAULT_GEMMA_CONFIG.files) {
        const s = await fsPromises.stat(path.join(dir, file)).catch(() => null)
        if (s) bytes += s.size
      }
    } catch {}
    return bytes
  }

  /**
   * Resuelve el directorio de pesos o inicia la descarga atómica con reporte de progreso unificado.
   */
  async resolveOrDownloadModel(resourcesPath?: string): Promise<string> {
    const status = await this.checkStatus(resourcesPath)
    if (status.installed) {
      this.emitProgress({
        status: 'ready',
        progress: 100,
        message: 'Modelo verificado y listo en almacenamiento local.',
      })
      return status.modelDir
    }

    if (this.isDownloading) {
      throw new Error('Ya hay una descarga del modelo en curso.')
    }

    const userModelPath = path.join(this.targetDir, 'embeddinggemma')
    await fsPromises.mkdir(userModelPath, { recursive: true })

    try {
      this.isDownloading = true
      await this.downloadModelFiles(userModelPath)
      this.emitProgress({
        status: 'ready',
        progress: 100,
        message: 'Descarga de EmbeddingGemma completada y verificada.',
      })
      return userModelPath
    } finally {
      this.isDownloading = false
    }
  }

  private async isModelComplete(dir: string): Promise<boolean> {
    try {
      const stats = await fsPromises.stat(dir)
      if (!stats.isDirectory()) return false

      for (const file of DEFAULT_GEMMA_CONFIG.files) {
        const fullPath = path.join(dir, file)
        const fileStat = await fsPromises.stat(fullPath)
        if (fileStat.size <= 0) return false
      }
      return true
    } catch {
      return false
    }
  }

  private async downloadModelFiles(destDir: string): Promise<void> {
    const baseUrl = `https://huggingface.co/${DEFAULT_GEMMA_CONFIG.repoId}/resolve/main`
    const files = DEFAULT_GEMMA_CONFIG.files

    // Calcular bytes ya existentes para progreso global coherente
    let overallBytes = 0
    for (const relFile of files) {
      const targetFile = path.join(destDir, relFile)
      const existing = await fsPromises.stat(targetFile).catch(() => null)
      if (existing && existing.size > 0) {
        overallBytes += existing.size
      }
    }

    const initialPct = Math.max(1, Math.floor((overallBytes / ESTIMATED_TOTAL_BYTES) * 100))
    this.emitProgress({
      status: 'downloading',
      progress: initialPct,
      downloadedBytes: overallBytes,
      totalBytes: ESTIMATED_TOTAL_BYTES,
      message: 'Conectando con Hugging Face (IPv4)...',
    })

    for (let i = 0; i < files.length; i++) {
      const relFile = files[i]!
      const fileUrl = `${baseUrl}/${relFile}`
      const targetFile = path.join(destDir, relFile)
      await fsPromises.mkdir(path.dirname(targetFile), { recursive: true })

      // Si el archivo ya existe y tiene tamaño válido, no lo descargamos de nuevo
      const existing = await fsPromises.stat(targetFile).catch(() => null)
      if (existing && existing.size > 0) {
        continue
      }

      this.emitProgress({
        status: 'downloading',
        progress: Math.min(99, Math.max(1, Math.floor((overallBytes / ESTIMATED_TOTAL_BYTES) * 100))),
        downloadedBytes: overallBytes,
        totalBytes: ESTIMATED_TOTAL_BYTES,
        message: `Descargando componente (${i + 1}/${files.length}): ${path.basename(relFile)}...`,
      })

      // Descargar con hasta 3 reintentos automáticos
      let attempts = 0
      let success = false
      let lastError: Error | null = null

      while (attempts < 3 && !success) {
        attempts++
        try {
          await this.downloadFileWithRedirects(fileUrl, targetFile, (chunkLength) => {
            overallBytes += chunkLength
            const now = Date.now()
            if (now - this.lastEmitTime > 200 || overallBytes - this.lastEmitBytes > 400_000) {
              this.lastEmitTime = now
              this.lastEmitBytes = overallBytes
              const pct = Math.min(99, Math.max(1, Math.floor((overallBytes / ESTIMATED_TOTAL_BYTES) * 100)))
              const mbDown = (overallBytes / 1024 / 1024).toFixed(1)
              const mbTotal = (ESTIMATED_TOTAL_BYTES / 1024 / 1024).toFixed(1)
              this.emitProgress({
                status: 'downloading',
                progress: pct,
                downloadedBytes: overallBytes,
                totalBytes: ESTIMATED_TOTAL_BYTES,
                message: `Descargando: ${mbDown} MB / ${mbTotal} MB (${pct}%) - ${path.basename(relFile)}`,
              })
            }
          })
          success = true
        } catch (err: any) {
          lastError = err
          if (attempts < 3) {
            await new Promise((r) => setTimeout(r, 1500 * attempts))
          }
        }
      }

      if (!success && lastError) {
        throw new Error(`Error descargando ${path.basename(relFile)} tras 3 intentos: ${lastError.message}`)
      }
    }
  }

  private downloadFileWithRedirects(
    urlStr: string,
    destPath: string,
    onChunk: (len: number) => void,
    maxRedirects = 6,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        return reject(new Error('Demasiadas redirecciones HTTP al conectar con Hugging Face'))
      }

      const isHttps = urlStr.startsWith('https')
      const client = isHttps ? https : http
      const options = {
        agent: isHttps ? httpsAgent : httpAgent,
        family: 4,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GraphMap/1.0',
          Accept: '*/*',
        },
      }

      const req = client.get(urlStr, options, (res) => {
        // Redirecciones (301, 302, 307, 308)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, urlStr).toString()
          res.resume()
          return resolve(this.downloadFileWithRedirects(redirectUrl, destPath, onChunk, maxRedirects - 1))
        }

        if (res.statusCode === 401 || res.statusCode === 403) {
          res.resume()
          return reject(
            new Error(
              `Acceso no autorizado (HTTP ${res.statusCode}). Hugging Face requiere autenticación para este modelo.`,
            ),
          )
        }

        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`Fallo HTTP ${res.statusCode} para ${path.basename(destPath)}`))
        }

        const tmpPath = `${destPath}.tmp`
        const fileStream = fs.createWriteStream(tmpPath)

        res.on('data', (chunk) => {
          onChunk(chunk.length)
        })

        res.pipe(fileStream)

        fileStream.on('finish', () => {
          fileStream.close(async () => {
            try {
              await fsPromises.rename(tmpPath, destPath).catch(async () => {
                await fsPromises.copyFile(tmpPath, destPath)
                await fsPromises.unlink(tmpPath).catch(() => {})
              })
              resolve()
            } catch (err) {
              reject(err)
            }
          })
        })

        fileStream.on('error', (err) => {
          fs.unlink(tmpPath, () => reject(err))
        })
      })

      req.setTimeout(35000, () => {
        req.destroy(new Error(`Timeout de conexión (35s) con Hugging Face para ${path.basename(destPath)}`))
      })

      req.on('error', reject)
    })
  }

  private emitProgress(p: ModelDownloadProgress) {
    if (this.onProgress) {
      try {
        this.onProgress(p)
      } catch {
        // ignore callback exceptions
      }
    }
  }
}
