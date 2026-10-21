import type { IEmbeddingProvider, ApiEmbeddingGemmaConfig } from '../types'
import { formatGemmaInput, batchFormatGemmaInput } from '../prefixes'
import { applyMrlAndNormalize, batchApplyMrlAndNormalize } from '../mrl'

export class ApiEmbeddingGemmaProvider implements IEmbeddingProvider {
  private baseUrl: string
  private apiKey?: string
  private modelName: string
  private dimension: number
  private timeoutMs: number
  private batchSize: number

  constructor(config: ApiEmbeddingGemmaConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.modelName = config.modelName || 'google/embeddinggemma-270m'
    this.dimension = config.dimension || 512
    this.timeoutMs = config.timeoutMs || 25000
    this.batchSize = config.batchSize || 32
  }

  getDimension(): number {
    return this.dimension
  }

  async embedQuery(text: string): Promise<number[]> {
    const formatted = formatGemmaInput(text, 'query')
    const rawVectors = await this.callApi([formatted])
    const raw = rawVectors[0]
    if (!raw) {
      throw new Error(`ApiEmbeddingGemma: no se recibió vector para la consulta.`)
    }
    return applyMrlAndNormalize(raw, this.dimension)
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    if (!documents.length) return []
    const formattedDocs = batchFormatGemmaInput(documents, 'document')
    const allVectors: number[][] = []

    for (let i = 0; i < formattedDocs.length; i += this.batchSize) {
      const chunk = formattedDocs.slice(i, i + this.batchSize)
      const rawVectors = await this.callApi(chunk)
      const normalized = batchApplyMrlAndNormalize(rawVectors, this.dimension)
      allVectors.push(...normalized)
    }

    return allVectors
  }

  private async callApi(inputs: string[]): Promise<number[][]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    // Determina URL: si termina en /embeddings úsalo, sino append /v1/embeddings o /embeddings
    let targetUrl = this.baseUrl
    if (!targetUrl.endsWith('/embeddings')) {
      targetUrl = targetUrl.endsWith('/v1') ? `${targetUrl}/embeddings` : `${targetUrl}/v1/embeddings`
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.modelName,
          input: inputs,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new Error(
          `ApiEmbeddingGemma HTTP ${response.status} (${response.statusText}): ${errorText.slice(0, 300)}`,
        )
      }

      const data = (await response.json()) as any

      // Soporta formato OpenAI estándar: { data: [{ embedding: [...] }, ...] }
      if (Array.isArray(data?.data)) {
        return data.data.map((item: any) => item.embedding)
      }

      // Soporta formato directo: { embeddings: [[...], [...]] }
      if (Array.isArray(data?.embeddings)) {
        return data.embeddings
      }

      // Soporta formato array raíz: [[...], [...]]
      if (Array.isArray(data) && Array.isArray(data[0])) {
        return data
      }

      throw new Error(`ApiEmbeddingGemma: Estructura de respuesta no reconocida desde ${targetUrl}`)
    } finally {
      clearTimeout(timeout)
    }
  }
}
