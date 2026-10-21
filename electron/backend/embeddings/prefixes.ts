/**
 * Task Prefixing para EmbeddingGemma
 *
 * El modelo requiere prefijos instructivos específicos para diferenciar consultas
 * de búsqueda de fragmentos o documentos de código fuente indexados:
 * - Query:    "task: search query | query: <texto>"
 * - Document: "task: search document | document: <texto>"
 */

import type { TaskType } from './types'

export function formatGemmaInput(text: string, taskType: TaskType): string {
  const clean = String(text ?? '').trim()
  if (taskType === 'query') {
    return `task: search query | query: ${clean}`
  }
  return `task: search document | document: ${clean}`
}

export function batchFormatGemmaInput(texts: string[], taskType: TaskType): string[] {
  return texts.map((t) => formatGemmaInput(t, taskType))
}
