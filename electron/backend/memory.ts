import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { localEmbeddings } from './server'

export type AgentMemory = {
  id: string
  key: string
  content: string
  summary: string
  tags: string[]
  filePath?: string | null
  projectId?: string | null
  createdAt: number
  updatedAt: number
  accessCount: number
  tokensEstimated: number
  vector?: number[]
}

export type MemoryStats = {
  totalMemories: number
  totalTokensSaved: number
  totalTokensEstimated: number
}

type MemoryStoreFile = {
  memories: AgentMemory[]
  totalTokensSaved: number
}

let cachedStore: MemoryStoreFile | null = null

function getStoragePath(): string {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'embeding-electron', 'agent_memory.json')
  }
  return path.join(process.cwd(), 'agent_memory.json')
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true })
}

async function readStore(): Promise<MemoryStoreFile> {
  if (cachedStore) return cachedStore
  const p = getStoragePath()
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<MemoryStoreFile>
    cachedStore = {
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
      totalTokensSaved: typeof parsed.totalTokensSaved === 'number' ? parsed.totalTokensSaved : 0,
    }
  } catch {
    cachedStore = { memories: [], totalTokensSaved: 0 }
  }
  return cachedStore
}

async function writeStore(store: MemoryStoreFile): Promise<void> {
  cachedStore = store
  const p = getStoragePath()
  await ensureDir(path.dirname(p))
  const tmp = `${p}.${Date.now()}.tmp`
  const data = JSON.stringify(store, null, 2)
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, p).catch(async () => {
    await fs.copyFile(tmp, p)
    await fs.unlink(tmp).catch(() => {})
  })
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text || '').length / 4))
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] || 0) * (b[i] || 0)
  }
  return dot
}

export async function storeMemory(params: {
  key: string
  content: string
  summary?: string
  tags?: string[]
  filePath?: string | null
  projectId?: string | null
}): Promise<AgentMemory> {
  const store = await readStore()
  const key = String(params.key || '').trim()
  if (!key) throw new Error('Se requiere un "key" para guardar en memoria.')
  const content = String(params.content || '').trim()
  if (!content) throw new Error('Se requiere "content" para guardar en memoria.')

  const summary = params.summary ? params.summary.trim() : content.slice(0, 160)
  const tags = Array.isArray(params.tags) ? params.tags.map((t) => String(t).trim()).filter(Boolean) : []
  const filePath = params.filePath ? String(params.filePath).trim() : null
  const projectId = params.projectId ? String(params.projectId).trim() : null
  const tokensEstimated = estimateTokens(content)

  // Calcular embedding vectorial para la memoria
  const embs = localEmbeddings([`${key} ${tags.join(' ')} ${summary} ${content}`])
  const vector = embs[0] || []

  const existingIdx = store.memories.findIndex((m) => {
    const keyMatch = m.key.toLowerCase() === key.toLowerCase()
    if (!keyMatch) return false
    if (projectId && m.projectId && m.projectId !== projectId) return false
    return true
  })
  const now = Date.now()

  let memory: AgentMemory
  if (existingIdx >= 0) {
    const prev = store.memories[existingIdx]!
    memory = {
      ...prev,
      content,
      summary,
      tags,
      filePath: filePath ?? prev.filePath,
      projectId: projectId ?? prev.projectId,
      updatedAt: now,
      tokensEstimated,
      vector,
    }
    store.memories[existingIdx] = memory
  } else {
    memory = {
      id: randomUUID(),
      key,
      content,
      summary,
      tags,
      filePath,
      projectId,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      tokensEstimated,
      vector,
    }
    store.memories.unshift(memory)
  }

  await writeStore(store)
  return memory
}

export async function recallMemories(
  query: string,
  limit = 5,
  projectId?: string | null,
): Promise<{
  memories: Array<AgentMemory & { relevance: number }>
  tokensSavedNow: number
  totalTokensSaved: number
}> {
  const store = await readStore()
  const q = String(query || '').trim().toLowerCase()

  let pool = store.memories
  if (projectId) {
    pool = pool.filter((m) => !m.projectId || m.projectId === projectId)
  }

  if (!q) {
    return {
      memories: pool.slice(0, limit).map((m) => ({ ...m, relevance: 1 })),
      tokensSavedNow: 0,
      totalTokensSaved: store.totalTokensSaved,
    }
  }

  const qEmbs = localEmbeddings([q])
  const qVec = qEmbs[0] || []

  const scored = pool.map((m) => {
    let score = 0
    if (m.vector && m.vector.length) {
      score = cosineSimilarity(qVec, m.vector)
    }

    // Boost exact key match or tag match
    if (m.key.toLowerCase().includes(q)) score += 0.35
    if (m.tags.some((t) => t.toLowerCase().includes(q))) score += 0.25
    if (m.filePath && m.filePath.toLowerCase().includes(q)) score += 0.15

    return { ...m, relevance: Math.round(score * 1000) / 1000 }
  })

  scored.sort((a, b) => b.relevance - a.relevance)
  const top = scored.slice(0, limit)

  let tokensSavedNow = 0
  for (const m of top) {
    m.accessCount += 1
    tokensSavedNow += m.tokensEstimated
  }

  store.totalTokensSaved += tokensSavedNow
  await writeStore(store)

  return {
    memories: top,
    tokensSavedNow,
    totalTokensSaved: store.totalTokensSaved,
  }
}

export async function listMemories(projectId?: string | null): Promise<{
  memories: AgentMemory[]
  stats: MemoryStats
}> {
  const store = await readStore()
  let pool = store.memories
  if (projectId) {
    pool = pool.filter((m) => !m.projectId || m.projectId === projectId)
  }

  const totalTokensEstimated = pool.reduce((sum, m) => sum + (m.tokensEstimated || 0), 0)
  return {
    memories: pool,
    stats: {
      totalMemories: pool.length,
      totalTokensSaved: store.totalTokensSaved,
      totalTokensEstimated,
    },
  }
}

export async function deleteMemory(keyOrId: string, projectId?: string | null): Promise<boolean> {
  const store = await readStore()
  const needle = keyOrId.toLowerCase()
  const initialLen = store.memories.length
  store.memories = store.memories.filter((m) => {
    if (projectId && m.projectId && m.projectId !== projectId) return true
    return m.id.toLowerCase() !== needle && m.key.toLowerCase() !== needle
  })
  if (store.memories.length !== initialLen) {
    await writeStore(store)
    return true
  }
  return false
}

export async function clearAllMemories(projectId?: string | null): Promise<void> {
  const store = await readStore()
  if (projectId) {
    store.memories = store.memories.filter((m) => m.projectId && m.projectId !== projectId)
  } else {
    store.memories = []
  }
  await writeStore(store)
}
