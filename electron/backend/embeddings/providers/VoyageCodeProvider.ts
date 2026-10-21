import type { IEmbeddingProvider } from '../types'

export interface VoyageConfig {
  apiKey?: string
  apiUrl?: string
  model?: string
  inputType?: string
  rpm?: number
  tpm?: number
  autoBatch?: boolean
  batchSize?: number
  maxCharsPerBatch?: number
  maxRetries?: number
  dimension?: number
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class VoyageCodeProvider implements IEmbeddingProvider {
  private config: VoyageConfig
  private lastCallMs = 0
  private tokensInWindow = 0
  private windowStartMs = Date.now()

  constructor(config: VoyageConfig = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.VOYAGE_API_KEY || '',
      apiUrl: config.apiUrl || process.env.VOYAGE_API_URL || 'https://api.voyageai.com',
      model: config.model || process.env.VOYAGE_EMBEDDING_MODEL || 'voyage-code-3',
      inputType: config.inputType || process.env.VOYAGE_INPUT_TYPE || 'document',
      rpm: config.rpm ?? Number(process.env.VOYAGE_RPM || 3),
      tpm: config.tpm ?? Number(process.env.VOYAGE_TPM || 10000),
      autoBatch: config.autoBatch ?? true,
      batchSize: config.batchSize ?? 128,
      maxCharsPerBatch: config.maxCharsPerBatch ?? 0,
      maxRetries: config.maxRetries ?? 8,
      dimension: config.dimension ?? 1024,
    }
  }

  getDimension(): number {
    return this.config.dimension ?? 1024
  }

  async embedQuery(text: string): Promise<number[]> {
    const results = await this.embedWithRetry([text], 'query')
    if (!results[0]) {
      throw new Error('Voyage no devolvió embedding para la consulta')
    }
    return results[0]
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    if (!documents.length) return []
    return await this.embedDocumentsBatched(documents)
  }

  private async embedDocumentsBatched(documents: string[]): Promise<number[][]> {
    const rpm = Math.max(1, this.config.rpm || 3)
    const tpm = Math.max(1, this.config.tpm || 10000)
    const safeTokensPerReq = Math.floor((tpm / rpm) * 0.9)
    const safeCharsPerReq = safeTokensPerReq > 0 ? safeTokensPerReq * 4 : 0

    let maxChars = this.config.maxCharsPerBatch || 0
    if (this.config.autoBatch && safeCharsPerReq > 0) {
      maxChars = maxChars > 0 ? Math.min(maxChars, safeCharsPerReq) : safeCharsPerReq
    }

    const batchLimit = Math.max(1, this.config.batchSize || 128)
    const out: number[][] = []
    let currentBatch: string[] = []
    let currentChars = 0

    const flush = async () => {
      if (!currentBatch.length) return
      const embs = await this.embedWithRetry(currentBatch, this.config.inputType || 'document')
      out.push(...embs)
      currentBatch = []
      currentChars = 0
    }

    for (const doc of documents) {
      const len = doc.length
      if (currentBatch.length && (currentBatch.length >= batchLimit || (maxChars > 0 && currentChars + len > maxChars))) {
        await flush()
      }
      currentBatch.push(doc)
      currentChars += len
    }
    await flush()

    return out
  }

  private async embedWithRetry(textos: string[], inputType: string): Promise<number[][]> {
    const apiKey = this.config.apiKey || process.env.VOYAGE_API_KEY
    if (!apiKey) {
      throw new Error('Falta VOYAGE_API_KEY en configuración.')
    }

    const url = `${this.config.apiUrl}/v1/embeddings`
    const model = this.config.model
    const maxRetries = this.config.maxRetries ?? 8

    let lastError: unknown = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.throttle(this.estimateTokens(textos))

      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey.replace(/[\r\n\t]/g, '')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, input: textos, input_type: inputType }),
          signal: AbortSignal.timeout(35000),
        })
      } catch (netErr: any) {
        if (attempt < maxRetries) {
          const backoffS = 2 * 2 ** attempt
          await sleep(backoffS * 1000)
          continue
        }
        const cause = netErr?.cause ? ` (Causa: ${netErr.cause.message || netErr.cause.code || netErr.cause})` : ''
        throw new Error(`Error de conexión con Voyage AI (${url}): ${netErr.message}${cause}`)
      }

      if (res.status === 401) {
        let errDetail = ''
        try {
          const jsonBody: any = await res.json()
          errDetail = jsonBody?.detail || jsonBody?.message || (typeof jsonBody === 'object' ? JSON.stringify(jsonBody) : String(jsonBody))
        } catch {
          try { errDetail = await res.text() } catch {}
        }
        throw new Error(`VOYAGE_API_KEY rechazada por Voyage AI (Error 401${errDetail ? `: ${errDetail}` : ''}). Verifica tu clave en Configuración o cambia a proveedor "local".`)
      }

      if ([429, 500, 502, 503, 504].includes(res.status)) {
        if (res.status === 429 && textos.length > 1) {
          const mid = Math.max(1, Math.floor(textos.length / 2))
          const a = await this.embedWithRetry(textos.slice(0, mid), inputType)
          const b = await this.embedWithRetry(textos.slice(mid), inputType)
          return [...a, ...b]
        }

        const retryAfter = Number(res.headers.get('Retry-After') || 0)
        const backoffS = 2 * 2 ** attempt
        await sleep(Math.max(retryAfter, backoffS) * 1000)
        continue
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Voyage API error (${res.status}): ${detail}`)
      }

      const payload = (await res.json()) as any
      if (Array.isArray(payload?.data)) {
        return payload.data.map((item: any) => item.embedding)
      }
      if (Array.isArray(payload?.embeddings)) {
        return payload.embeddings as number[][]
      }
      throw new Error('Respuesta inesperada del proveedor Voyage.')
    }

    throw lastError instanceof Error ? lastError : new Error('Reintentos agotados al invocar Voyage API')
  }

  private estimateTokens(textos: string[]): number {
    return Math.ceil(textos.reduce((acc, t) => acc + t.length, 0) / 4)
  }

  private async throttle(tokens: number) {
    const rpm = Math.max(1, this.config.rpm || 3)
    const minIntervalMs = (60 / rpm) * 1000
    const now = Date.now()

    if (now - this.windowStartMs >= 60000) {
      this.windowStartMs = now
      this.tokensInWindow = 0
    }

    const tpm = Math.max(1, this.config.tpm || 10000)
    if (this.tokensInWindow + tokens > tpm) {
      const waitMs = Math.max(200, 60000 - (now - this.windowStartMs))
      await sleep(waitMs)
      this.windowStartMs = Date.now()
      this.tokensInWindow = 0
    }

    const elapsedSinceLast = now - this.lastCallMs
    if (elapsedSinceLast < minIntervalMs) {
      await sleep(minIntervalMs - elapsedSinceLast)
    }

    this.lastCallMs = Date.now()
    this.tokensInWindow += tokens
  }
}
