import type { IEmbeddingProvider, EmbeddingProviderType } from './types'
import { VoyageCodeProvider } from './providers/VoyageCodeProvider'
import { LocalEmbeddingGemmaProvider } from './providers/LocalEmbeddingGemmaProvider'
import { ApiEmbeddingGemmaProvider } from './providers/ApiEmbeddingGemmaProvider'

let currentProvider: IEmbeddingProvider | null = null
let currentProviderType: string = ''

export class EmbeddingProviderFactory {
  static async createProvider(
    providerType: EmbeddingProviderType | string,
    options: {
      dimension?: 256 | 512 | 768 | 1024
      apiUrl?: string
      apiKey?: string
      onProgress?: (p: any) => void
    } = {},
  ): Promise<IEmbeddingProvider> {
    const type = (providerType || 'local').toLowerCase().trim()

    switch (type) {
      case 'gemma-local':
        return new LocalEmbeddingGemmaProvider({
          dimension: options.dimension || 512,
          onProgress: options.onProgress,
        })

      case 'gemma-api':
        return new ApiEmbeddingGemmaProvider({
          baseUrl: options.apiUrl || 'http://localhost:8000/v1',
          apiKey: options.apiKey,
          dimension: options.dimension || 512,
        })

      case 'voyage':
        return new VoyageCodeProvider({
          dimension: 1024,
        })

      case 'local':
      default:
        // Por defecto, gemma-local o Voyage según configuración
        return new LocalEmbeddingGemmaProvider({
          dimension: options.dimension || 512,
          onProgress: options.onProgress,
        })
    }
  }

  static async getActiveProvider(
    providerType: string,
    options: {
      dimension?: 256 | 512 | 768 | 1024
      apiUrl?: string
      apiKey?: string
      onProgress?: (p: any) => void
    } = {},
  ): Promise<IEmbeddingProvider> {
    const key = `${providerType}_${options.dimension || 512}_${options.apiUrl || ''}`
    if (currentProvider && currentProviderType === key) {
      return currentProvider
    }

    if (currentProvider?.dispose) {
      await currentProvider.dispose().catch(() => {})
    }

    currentProvider = await this.createProvider(providerType, options)
    currentProviderType = key
    return currentProvider
  }
}
