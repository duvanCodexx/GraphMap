/**
 * Matryoshka Representation Learning (MRL) utilities
 *
 * Los modelos entrenados con MRL (como EmbeddingGemma) permiten truncar los vectores
 * a subdimensiones menores (ej. 256, 512) conservando gran parte de la calidad semántica.
 * Tras el truncamiento, es requisito matemático indispensable aplicar normalización L2
 * para que las medidas de similitud por coseno o producto escalar sigan siendo válidas.
 */

export function applyMrlAndNormalize(vector: number[] | Float32Array, targetDim: number): number[] {
  const dim = Math.min(targetDim, vector.length)
  const truncated = new Array<number>(dim)

  let sumSq = 0
  for (let i = 0; i < dim; i++) {
    const val = Number(vector[i] ?? 0)
    truncated[i] = val
    sumSq += val * val
  }

  const norm = Math.sqrt(sumSq)
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      truncated[i] = truncated[i]! / norm
    }
  } else {
    // En caso de vector nulo, distribuir norma unitaria uniforme
    const uniform = 1 / Math.sqrt(dim)
    for (let i = 0; i < dim; i++) {
      truncated[i] = uniform
    }
  }

  return truncated
}

export function batchApplyMrlAndNormalize(vectors: (number[] | Float32Array)[], targetDim: number): number[][] {
  return vectors.map((v) => applyMrlAndNormalize(v, targetDim))
}
