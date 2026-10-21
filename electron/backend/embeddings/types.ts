/**
 * EMBEDING-ELECTRON - Embedding Provider Types & Interfaces
 */

export interface IEmbeddingProvider {
  /**
   * Genera el embedding para una consulta de búsqueda (query).
   * Aplica el prefijo instructivo de búsqueda y reducción MRL si corresponde.
   */
  embedQuery(text: string): Promise<number[]>

  /**
   * Genera los embeddings para un lote de documentos o fragmentos de código.
   * Aplica el prefijo instructivo de documento y reducción MRL en lote.
   */
  embedDocuments(documents: string[]): Promise<number[][]>

  /**
   * Retorna la dimensión vectorial activa producida por este proveedor (ej: 256, 512, 1024).
   */
  getDimension(): number

  /**
   * Limpieza de recursos, cierre de procesos o sockets si aplica.
   */
  dispose?(): Promise<void>
}

export type EmbeddingProviderType = 'local' | 'voyage' | 'gemma-local' | 'gemma-api'

export type TaskType = 'query' | 'document'

export interface ModelDownloadProgress {
  status: 'idle' | 'checking' | 'downloading' | 'loading' | 'ready' | 'error'
  progress: number // 0 a 100
  downloadedBytes?: number
  totalBytes?: number
  message: string
}

export interface LocalEmbeddingGemmaConfig {
  modelName?: string
  dimension: 256 | 512 | 768 | 1024
  batchSize?: number
  quantized?: boolean
  modelsDir?: string
  onProgress?: (progress: ModelDownloadProgress) => void
}

export interface ApiEmbeddingGemmaConfig {
  baseUrl: string
  apiKey?: string
  modelName?: string
  dimension: 256 | 512 | 768 | 1024
  timeoutMs?: number
  batchSize?: number
}
