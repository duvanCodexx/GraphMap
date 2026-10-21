import http from 'node:http'
import { URL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import dns from 'node:dns'

try {
  dns.setDefaultResultOrder('ipv4first')
} catch {}

import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import * as lancedb from '@lancedb/lancedb'
import { getSecretValue, getSettingsUi, updateSettingsUi, type SettingsPublic } from './settings'
import { EmbeddingProviderFactory } from './embeddings/factory'
import type { IEmbeddingProvider } from './embeddings/types'
import { applyMrlAndNormalize } from './embeddings/mrl'
import { chunkFileContent, detectLanguage } from './chunker'
import { storeMemory, recallMemories, listMemories, deleteMemory } from './memory'
import { broadcastEvent, recordAgentActivity, registerSseClient, getRecentActivity, getLastAgentSearch } from './activity'
import { checkLocalModelStatus, downloadLocalModel } from './embeddings/providers/LocalEmbeddingGemmaProvider'
import {
  getAllProjects,
  getActiveProject,
  setActiveProject,
  registerOrGetProject,
  getProject,
  updateProjectStats,
  removeProject,
  canonicalizePath,
  onProjectsChange,
  type ProjectRecord,
} from './projects'

// Sincronización en tiempo real vía SSE para agentes MCP y cambios externos de proyectos
onProjectsChange(async ({ activeProjectId, project }) => {
  try {
    const all = await getAllProjects()
    broadcastEvent({
      action: 'projects_changed',
      activeProjectId: activeProjectId || undefined,
      project: project || undefined,
      projects: all,
    })
  } catch {}
})

type BackendConfig = {
  projectPath: string | null
}

type ReindexProgress = {
  total_files: number | null
  processed_files: number
  indexed_files: number
  total_chunks: number
  indexed_chunks: number
  errors: number
  current_file: string | null
  files_remaining: number | null
  last_update_at: number
  files_percent?: number
  elapsed_s?: number
}

type ReindexJob = {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  created_at: number
  started_at: number | null
  finished_at: number | null
  exit_code: number | null
  error: string | null
  log_tail: string
  progress: ReindexProgress | null
  projectId?: string
  projectName?: string
  projectPath?: string
}

export const DEFAULT_PORT = Number(process.env.BACKEND_PORT || 8001)
export const CANDIDATE_PORTS = [8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010]
const DEFAULT_IGNORE_DIRS =
  'node_modules,vendor,storage,.git,dist,__pycache__,.next,build,venv,.venv,coverage,.pytest_cache,.trae,.idea,.vscode'
const DEFAULT_IGNORE_FILES =
  'CHANGELOG.md,CHANGELOG.MD,README.md,README.MD,*.log,*.lock,composer.lock,package-lock.json,yarn.lock,pnpm-lock.yaml,.phpunit.result.cache'

function nowS() {
  return Date.now() / 1000
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
  res.end(payload)
}


async function readBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBody(req)
  if (!raw.trim()) return {} as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error('JSON inválido')
  }
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true })
}

type SettingsSnapshot = {
  values: Record<string, string>
  secrets: {
    GROQ_API_KEY: string | null
    VOYAGE_API_KEY: string | null
    GEMMA_API_KEY: string | null
  }
  get: (key: keyof SettingsPublic) => string
  getInt: (key: keyof SettingsPublic, def: number) => number
  getBool: (key: keyof SettingsPublic, def: boolean) => boolean
}

async function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  const ui = await getSettingsUi()
  const groq = await getSecretValue('GROQ_API_KEY')
  const voyage = await getSecretValue('VOYAGE_API_KEY')
  const gemma = await getSecretValue('GEMMA_API_KEY')
  const values = ui.values || {}

  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== 'string') continue
    process.env[k] = v
  }
  if (groq) process.env.GROQ_API_KEY = groq
  if (voyage) process.env.VOYAGE_API_KEY = voyage
  if (gemma) process.env.GEMMA_API_KEY = gemma

  const get = (key: keyof SettingsPublic) => String((values as any)[key] || process.env[key] || '')
  const getInt = (key: keyof SettingsPublic, def: number) => envInt(String(key), def)
  const getBool = (key: keyof SettingsPublic, def: boolean) => envBool(String(key), def)

  return {
    values,
    secrets: { GROQ_API_KEY: groq, VOYAGE_API_KEY: voyage, GEMMA_API_KEY: gemma },
    get,
    getInt,
    getBool,
  }
}

function envInt(name: string, def: number) {
  const raw = process.env[name]
  if (!raw) return def
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : def
}

function envBool(name: string, def: boolean) {
  const raw = process.env[name]
  if (raw == null) return def
  return String(raw).trim().toLowerCase() in { '1': true, true: true, yes: true, y: true, on: true }
}

function parseCsv(raw: string | undefined | null) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function matchPattern(name: string, pattern: string) {
  if (!pattern.includes('*') && !pattern.includes('?')) return name === pattern
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  )
  return rx.test(name)
}

async function listFiles(rootDir: string, extensionsCsv: string, ignoreDirsCsv: string, ignoreFilesCsv: string) {
  const exts = parseCsv(extensionsCsv || '.py,.ts,.js,.md')
  const ignoreDirs = new Set([...parseCsv(ignoreDirsCsv || DEFAULT_IGNORE_DIRS), ...parseCsv(DEFAULT_IGNORE_DIRS)])
  const ignoreFiles = parseCsv(ignoreFilesCsv || DEFAULT_IGNORE_FILES)
  const out: string[] = []

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ignoreDirs.has(ent.name)) continue
        await walk(path.join(dir, ent.name))
        continue
      }
      if (!ent.isFile()) continue
      if (ignoreFiles.some((p) => matchPattern(ent.name, p))) continue
      if (!exts.some((e) => ent.name.toLowerCase().endsWith(e.toLowerCase()))) continue
      out.push(path.join(dir, ent.name))
    }
  }

  await walk(rootDir)
  return out
}

// Nota: El chunking logico por funciones/clases/componentes y deteccion de lenguaje
// son provistos por ./chunker.ts


function voyageApiUrl() {
  return String(process.env.VOYAGE_API_URL || 'https://api.voyageai.com').replace(/\/+$/, '')
}

function voyageModel() {
  return String(process.env.VOYAGE_EMBEDDING_MODEL || 'voyage-code-3')
}

function voyageInputType() {
  return String(process.env.VOYAGE_INPUT_TYPE || 'document')
}

let voyageLastRequestAtS = 0
let voyageWindowStartS = 0
let voyageUsedTokens = 0

function voyageProfile() {
  return String(process.env.VOYAGE_RATE_LIMIT_PROFILE || 'free')
    .trim()
    .toLowerCase()
}

function voyageLimits() {
  const profile = voyageProfile()
  if (profile === 'tier1' || profile === 'basic') {
    return { rpm: Number(process.env.VOYAGE_RPM || 2000), tpm: envInt('VOYAGE_TPM', 3_000_000) }
  }
  if (profile === 'free' || profile === 'trial') {
    return { rpm: Number(process.env.VOYAGE_RPM || 3), tpm: envInt('VOYAGE_TPM', 10_000) }
  }
  if (profile === 'custom') {
    return { rpm: Number(process.env.VOYAGE_RPM || 3), tpm: envInt('VOYAGE_TPM', 10_000) }
  }
  return { rpm: Number(process.env.VOYAGE_RPM || 3), tpm: envInt('VOYAGE_TPM', 10_000) }
}

function voyageMinIntervalS() {
  const { rpm } = voyageLimits()
  if (!Number.isFinite(rpm) || rpm <= 0) return 0
  return 60 / rpm
}

function voyageEstimateTokens(textos: string[]) {
  let total = 0
  for (const t of textos) total += Math.max(1, Math.floor((t.length + 3) / 4))
  return total
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function voyageThrottle(plannedTokens: number) {
  const { tpm } = voyageLimits()
  const now = Date.now() / 1000

  if (voyageWindowStartS <= 0) {
    voyageWindowStartS = now
    voyageUsedTokens = 0
  }

  let elapsed = now - voyageWindowStartS
  if (elapsed >= 60) {
    voyageWindowStartS = now
    voyageUsedTokens = 0
    elapsed = 0
  }

  if (tpm > 0 && voyageUsedTokens + plannedTokens > tpm && elapsed < 60) {
    await sleep(Math.max(0, (60 - elapsed) * 1000))
    const now2 = Date.now() / 1000
    voyageWindowStartS = now2
    voyageUsedTokens = 0
  }

  const minInterval = voyageMinIntervalS()
  if (minInterval <= 0) {
    voyageUsedTokens += plannedTokens
    return
  }

  const now3 = Date.now() / 1000
  const waitS = voyageLastRequestAtS + minInterval - now3
  if (waitS > 0) await sleep(waitS * 1000)
  voyageLastRequestAtS = Date.now() / 1000
  voyageUsedTokens += plannedTokens
}

function fnv1a(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function localEmbeddings(textos: string[], dim = 512): number[][] {
  const out: number[][] = []

  for (const t of textos) {
    const vec = new Float64Array(dim)
    const normalized = (t || '').toLowerCase()
    const tokens = normalized.match(/[a-z0-9_$]{2,}/g) || []

    for (const tok of tokens) {
      const h1 = fnv1a(tok)
      const s1 = fnv1a(tok + ':s') % 2 === 0 ? 1 : -1
      vec[h1 % dim] += s1 * 2.0

      if (tok.length >= 3) {
        for (let j = 0; j <= tok.length - 3; j++) {
          const tri = tok.slice(j, j + 3)
          const hTri = fnv1a(tri)
          const sTri = fnv1a(tri + ':s') % 2 === 0 ? 1 : -1
          vec[hTri % dim] += sTri * 0.7
        }
      }
      if (tok.length >= 4) {
        for (let j = 0; j <= tok.length - 4; j++) {
          const quad = tok.slice(j, j + 4)
          const hQuad = fnv1a(quad)
          const sQuad = fnv1a(quad + ':s') % 2 === 0 ? 1 : -1
          vec[hQuad % dim] += sQuad * 0.9
        }
      }
    }

    const symbolMatches = t.match(/(?:Simbolo|Archivo|Scope|function|class|def|method|component):\s*([^\n]+)/gi) || []
    for (const sm of symbolMatches) {
      const smTokens = sm.toLowerCase().match(/[a-z0-9_$]{2,}/g) || []
      for (const st of smTokens) {
        const hS = fnv1a(st)
        const sS = fnv1a(st + ':s') % 2 === 0 ? 1 : -1
        vec[hS % dim] += sS * 3.5
      }
    }

    let sumSq = 0
    for (let i = 0; i < dim; i++) {
      sumSq += vec[i] * vec[i]
    }
    const norm = Math.sqrt(sumSq)
    const result = new Array<number>(dim)
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        result[i] = vec[i] / norm
      }
    } else {
      const uniform = 1 / Math.sqrt(dim)
      for (let i = 0; i < dim; i++) {
        result[i] = uniform
      }
    }
    out.push(result)
  }

  return out
}

async function voyageEmbeddings(textos: string[]): Promise<number[][]> {
  const apiKey = (await getSecretValue('VOYAGE_API_KEY')) || String(process.env.VOYAGE_API_KEY || '').trim()
  if (!apiKey) throw new Error('Falta VOYAGE_API_KEY en el entorno (revisa Settings o cambia EMBEDDING_PROVIDER a "local")')

  const url = `${voyageApiUrl()}/v1/embeddings`
  const model = voyageModel()
  const input_type = voyageInputType()

  const maxRetries = envInt('VOYAGE_MAX_RETRIES', 8)
  const baseBackoffS = Number(process.env.VOYAGE_RETRY_BACKOFF_S || 2)

  let lastError: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await voyageThrottle(voyageEstimateTokens(textos))

    const reqBody: Record<string, any> = { model, input: textos, input_type }
    const outDim = envInt('VOYAGE_OUTPUT_DIMENSION', 0)
    if (outDim === 256 || outDim === 512 || outDim === 1024 || outDim === 2048) {
      reqBody.output_dimension = outDim
    }

    let r: Response
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.replace(/[\r\n\t]/g, '')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(35000),
      })
    } catch (netErr: any) {
      if (attempt < maxRetries) {
        const backoffS = baseBackoffS * 2 ** attempt
        await sleep(backoffS * 1000)
        continue
      }
      const cause = netErr?.cause ? ` (Causa: ${netErr.cause.message || netErr.cause.code || netErr.cause})` : ''
      throw new Error(`Error de conexión con Voyage AI (${url}): ${netErr.message}${cause}`)
    }

    if (r.status === 401) {
      let errDetail = ''
      try {
        const jsonBody: any = await r.json()
        errDetail = jsonBody?.detail || jsonBody?.message || (typeof jsonBody === 'object' ? JSON.stringify(jsonBody) : String(jsonBody))
      } catch {
        try { errDetail = await r.text() } catch {}
      }
      throw new Error(`VOYAGE_API_KEY rechazada por Voyage AI (Error 401${errDetail ? `: ${errDetail}` : ''}). Verifica tu clave en Configuración o cambia a proveedor "local".`)
    }

    if ([429, 500, 502, 503, 504].includes(r.status)) {
      if (r.status === 429 && textos.length > 1) {
        const mid = Math.max(1, Math.floor(textos.length / 2))
        const a: number[][] = await voyageEmbeddings(textos.slice(0, mid))
        const b: number[][] = await voyageEmbeddings(textos.slice(mid))
        return [...a, ...b]
      }

      let detail: unknown = null
      try {
        detail = await r.json()
      } catch {
        detail = await r.text()
      }
      lastError = new Error(`Voyage embeddings error (${r.status}): ${JSON.stringify(detail)}`)
      if (attempt >= maxRetries) throw lastError

      const retryAfter = r.headers.get('Retry-After')
      const retryAfterS = retryAfter ? Number(retryAfter) : 0
      const backoffS = baseBackoffS * 2 ** attempt
      await sleep(Math.max(retryAfterS, voyageMinIntervalS(), backoffS) * 1000)
      continue
    }

    if (r.status >= 400) {
      let detail: unknown = null
      try {
        detail = await r.json()
      } catch {
        detail = await r.text()
      }
      throw new Error(`Voyage embeddings error (${r.status}): ${JSON.stringify(detail)}`)
    }

    const payload = (await r.json()) as any
    if (Array.isArray(payload?.data)) {
      const out: number[][] = []
      for (const item of payload.data) {
        const emb = item?.embedding
        if (!emb) throw new Error(`Respuesta inesperada de Voyage: ${Object.keys(item || {}).join(',')}`)
        out.push(emb)
      }
      return out
    }

    if (Array.isArray(payload?.embeddings)) return payload.embeddings as number[][]
    throw new Error(`Respuesta inesperada de Voyage: ${Object.keys(payload || {}).join(',')}`)
  }

  throw lastError instanceof Error ? lastError : new Error('Voyage embeddings error: reintentos agotados')
}

async function voyageEmbeddingsBatch(textos: string[]): Promise<number[][]> {
  const autoBatch = String(process.env.VOYAGE_AUTO_BATCH || 'true')
    .trim()
    .toLowerCase() in { '1': true, true: true, yes: true, y: true, on: true }
  const { rpm, tpm } = voyageLimits()
  const safeTokensPerReq = tpm > 0 && rpm > 0 ? Math.floor((tpm / Math.max(rpm, 1)) * 0.9) : 0
  const safeCharsPerReq = safeTokensPerReq > 0 ? safeTokensPerReq * 4 : 0

  const batch = envInt('VOYAGE_BATCH_SIZE', 128)
  const maxCharsEnv = process.env.VOYAGE_MAX_CHARS_PER_BATCH
  let maxChars = maxCharsEnv != null ? envInt('VOYAGE_MAX_CHARS_PER_BATCH', 0) : 0
  if (autoBatch && safeCharsPerReq > 0) maxChars = safeCharsPerReq
  if (maxCharsEnv != null && maxChars > 0 && safeCharsPerReq > 0) maxChars = Math.min(maxChars, safeCharsPerReq)
  if (maxChars <= 0) maxChars = safeCharsPerReq > 0 ? safeCharsPerReq : 8000

  const out: number[][] = []
  let actual: string[] = []
  let actualChars = 0

  const flush = async () => {
    if (!actual.length) return
    const embs = await voyageEmbeddings(actual)
    out.push(...embs)
    actual = []
    actualChars = 0
  }

  for (const t of textos) {
    const tChars = t.length
    if (actual.length && (actual.length >= batch || actualChars + tChars > maxChars)) await flush()
    actual.push(t)
    actualChars += tChars
  }
  await flush()
  return out
}

async function getActiveEmbeddingProvider(): Promise<IEmbeddingProvider> {
  const settings = await loadSettingsSnapshot()
  const provider = (settings.get('EMBEDDING_PROVIDER') || process.env.EMBEDDING_PROVIDER || 'gemma-local')
    .trim()
    .toLowerCase()

  const dimRaw = Number(settings.get('GEMMA_LOCAL_DIMENSION') || 512)
  const dim = (dimRaw === 256 || dimRaw === 512 || dimRaw === 768 || dimRaw === 1024 ? dimRaw : 512) as
    | 256
    | 512
    | 768
    | 1024
  const apiUrl = settings.get('GEMMA_API_URL') || 'http://localhost:8000/v1'
  const apiKey = settings.secrets.GEMMA_API_KEY || undefined

  if (provider === 'local') {
    return {
      embedQuery: async (t: string) => localEmbeddings([t], 512)[0]!,
      embedDocuments: async (docs: string[]) => localEmbeddings(docs, 512),
      getDimension: () => 512,
    }
  }

  if (provider === 'voyage') {
    return {
      embedQuery: async (t: string) => (await voyageEmbeddingsBatch([t]))[0]!,
      embedDocuments: async (docs: string[]) => voyageEmbeddingsBatch(docs),
      getDimension: () => 1024,
    }
  }

  if (provider === 'gemma-local') {
    const status = await checkLocalModelStatus()
    if (!status.installed) {
      return {
        embedQuery: async () => {
          throw new Error(
            'El modelo EmbeddingGemma local (~320MB) no está descargado aún. Ve a "Modelo" y presiona "Descargar Modelo Local" para instalarlo.',
          )
        },
        embedDocuments: async () => {
          throw new Error(
            'El modelo EmbeddingGemma local (~320MB) no está descargado aún. Ve a "Modelo" y presiona "Descargar Modelo Local" para instalarlo.',
          )
        },
        getDimension: () => dim,
      }
    }
  }

  return await EmbeddingProviderFactory.getActiveProvider(provider, {
    dimension: dim,
    apiUrl,
    apiKey,
  })
}

async function getEmbeddings(textos: string[]): Promise<number[][]> {
  const prov = await getActiveEmbeddingProvider()
  return await prov.embedDocuments(textos)
}

async function getQueryEmbedding(query: string): Promise<number[]> {
  const prov = await getActiveEmbeddingProvider()
  return await prov.embedQuery(query)
}

async function groqChat(query: string, contexto: string) {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim()
  if (!apiKey) throw new Error('Falta GROQ_API_KEY en el entorno')
  const model = String(process.env.GROQ_MODEL || 'llama-3.3-70b-versatile')
  const systemPrompt =
    'Eres un asistente experto en ingeniería de software y análisis de código fuente. Se te proporcionan fragmentos de código de un proyecto estructurados por funciones, clases, componentes y secciones lógicas con su archivo y líneas. Responde la pregunta del usuario con máxima precisión técnica basándote en el contexto provisto. Si la información no está en el contexto, indícalo claramente. Cita siempre el archivo, símbolo y líneas cuando sea aplicable. Responde siempre en español.'
  const userPrompt = `Contexto del proyecto:\n---\n${contexto}\n---\n\nPregunta: ${query}`

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  })

  if (r.status >= 400) {
    const body = await r.text()
    throw new Error(`Groq error (${r.status}): ${body}`)
  }

  const payload = (await r.json()) as any
  const content = payload?.choices?.[0]?.message?.content
  if (!content) throw new Error('Respuesta inesperada de Groq')
  return String(content)
}

let dbConn: lancedb.Connection | null = null

async function getDb() {
  if (dbConn && dbConn.isOpen()) return dbConn
  const dir = path.join(app.getPath('userData'), 'lancedb')
  await ensureDir(dir)
  dbConn = await lancedb.connect(dir)
  return dbConn
}

async function tableExists(db: lancedb.Connection, name: string) {
  const names = await db.tableNames()
  return names.includes(name)
}

async function openTableOrNull(db: lancedb.Connection, name: string) {
  if (!(await tableExists(db, name))) return null
  return await db.openTable(name)
}

async function resetTable(db: lancedb.Connection, name: string) {
  if (await tableExists(db, name)) {
    await db.dropTable(name)
  }
}

export async function resolveProjectTarget(projectTarget?: string | null): Promise<ProjectRecord> {
  if (projectTarget && projectTarget.trim()) {
    const raw = projectTarget.trim()
    const found = await getProject(raw)
    if (found) return found
    const cPath = canonicalizePath(raw)
    const exists = await fs.stat(cPath).then((s) => s.isDirectory()).catch(() => false)
    if (exists || path.isAbsolute(cPath) || raw.includes('/') || raw.includes('\\')) {
      return await registerOrGetProject(cPath)
    }
  }

  const active = await getActiveProject()
  if (active) return active

  // Fallback a settings.json PROJECT_PATH
  const settings = await loadSettingsSnapshot()
  const projectDir = (settings.get('PROJECT_PATH') || process.env.PROJECT_PATH || '').trim()
  if (projectDir) {
    return await registerOrGetProject(projectDir)
  }

  throw new Error('No hay proyectos registrados en el servidor ni se especificó "project_path".')
}

type BuscarRequest = { query: string; top_k?: number | null; usar_rag?: boolean; project?: string; project_path?: string }
type ReindexRequest = { confirmar?: boolean; project?: string; project_path?: string }

let reindexJob: ReindexJob | null = null
let reindexBusy = false

function tailPush(lines: string[], max: number, line: string) {
  const next = [...lines, line]
  if (next.length > max) return next.slice(-max)
  return next
}

function snapshotJob(job: ReindexJob): ReindexJob {
  const out: ReindexJob = { ...job, progress: job.progress ? { ...job.progress } : null }
  if (out.progress) {
    const total = out.progress.total_files
    const processed = out.progress.processed_files
    if (typeof total === 'number' && total > 0 && typeof processed === 'number') {
      out.progress.files_percent = Math.min(100, Math.round((processed / total) * 10000) / 100)
    }
    if (out.status === 'completed') {
      out.progress.files_percent = 100
      out.progress.files_remaining = 0
    }
    const startedAt = out.started_at
    if (typeof startedAt === 'number' && startedAt > 0) {
      out.progress.elapsed_s = Math.round((nowS() - startedAt) * 1000) / 1000
    }
  }
  return out
}

async function runReindexJob(jobId: string) {
  if (!reindexJob || reindexJob.id !== jobId) return

  const settings = await loadSettingsSnapshot()

  const startedAt = nowS()
  reindexJob.status = 'running'
  reindexJob.started_at = startedAt
  reindexJob.finished_at = null
  reindexJob.exit_code = null
  reindexJob.error = null
  reindexJob.progress = {
    total_files: null,
    processed_files: 0,
    indexed_files: 0,
    total_chunks: 0,
    indexed_chunks: 0,
    errors: 0,
    current_file: null,
    files_remaining: null,
    last_update_at: nowS(),
  }
  reindexJob.log_tail = ''

  const logLines: string[] = []
  const maxLogLines = envInt('REINDEX_LOG_MAX_LINES', 800)
  const timeoutS = envInt('REINDEX_TIMEOUT_S', 3600)

  const chunkSize = envInt('CHUNK_SIZE', 1200)
  const overlapLines = envInt('CHUNK_OVERLAP_LINES', 8)
  const flushEvery = envInt('FLUSH_EVERY', 50)
  const flushAfterEachFile = envBool('FLUSH_AFTER_EACH_FILE', true)
  const embedGroupSize = envInt('EMBED_GROUP_SIZE', 16)
  const embedGroupMaxChars = envInt('EMBED_GROUP_MAX_CHARS', 12000)

  const extensions = String(process.env.INDEX_EXTENSIONS || '.py,.ts,.js,.md')
  const ignoreDirs = String(process.env.INDEX_IGNORE_DIRS || DEFAULT_IGNORE_DIRS)
  const ignoreFiles = String(process.env.INDEX_IGNORE_FILES || DEFAULT_IGNORE_FILES)

  try {
    const targetProject = await resolveProjectTarget(reindexJob.projectId || reindexJob.projectPath)
    const projectDir = targetProject.path
    if (!projectDir) throw new Error('Ruta de proyecto no disponible')

    const stat = await fs.stat(projectDir).catch(() => null)
    if (!stat || !stat.isDirectory()) throw new Error(`No se encontró el directorio del proyecto en ${projectDir}`)

    const startedWall = Date.now()
    const tick = () => {
      if (!reindexJob || reindexJob.id !== jobId) return
      if ((Date.now() - startedWall) / 1000 > timeoutS) throw new Error(`Reindex timeout (${timeoutS}s)`)
    }

    const db = await getDb()
    const tableName = targetProject.tableName
    const resetIndex = settings.getBool('RESET_CHROMA', false)
    if (resetIndex) await resetTable(db, tableName)

    const files = await listFiles(projectDir, extensions, ignoreDirs, ignoreFiles)
    if (reindexJob && reindexJob.id === jobId && reindexJob.progress) {
      reindexJob.progress.total_files = files.length
      reindexJob.progress.files_remaining = files.length
      reindexJob.progress.last_update_at = nowS()
    }

    let table: lancedb.Table | null = resetIndex ? null : await openTableOrNull(db, tableName)

    // Si la tabla ya existe, verificar si la dimensión del modelo activo coincide con la de la tabla existente
    if (table && !resetIndex) {
      try {
        const sample = await table.query().select(['vector']).limit(1).toArray()
        const existingDim = sample?.[0]?.vector?.length
        const prov = await getActiveEmbeddingProvider()
        const targetDim = prov.getDimension()
        if (existingDim && existingDim !== targetDim) {
          // La dimensión cambió (ej. de 512D a 1024D). Limpiar la tabla previa para recrear el esquema limpio
          await resetTable(db, tableName).catch(() => {})
          table = null
        }
      } catch {}
    }

    let rows: any[] = []

    const flush = async () => {
      if (!rows.length) return
      if (!table) {
        table = await db.createTable(tableName, rows, { mode: 'overwrite' } as any)
      } else {
        try {
          await table.add(rows)
        } catch {
          await resetTable(db, tableName).catch(() => {})
          table = await db.createTable(tableName, rows, { mode: 'overwrite' } as any)
        }
      }
      rows = []
    }

    for (const absPath of files) {
      tick()
      const relPath = path.relative(projectDir, absPath).replace(/\\/g, '/')

      if (table && !resetIndex) {
        const escaped = relPath.replace(/'/g, "''")
        await table.delete(`filePath = '${escaped}'`).catch(() => {})
      }

      let fileText = ''
      try {
        fileText = await fs.readFile(absPath, 'utf8')
      } catch {
        fileText = await fs.readFile(absPath).then((b) => b.toString('utf8'))
      }
      if (fileText.trim().length < 30) {
        if (reindexJob && reindexJob.id === jobId && reindexJob.progress) {
          reindexJob.progress.processed_files += 1
          if (reindexJob.progress.total_files != null) {
            reindexJob.progress.files_remaining = Math.max(0, reindexJob.progress.total_files - reindexJob.progress.processed_files)
          }
          reindexJob.progress.last_update_at = nowS()
        }
        const line = `- ${relPath} (omitido: archivo < 30 caracteres)`
        logLines.splice(0, logLines.length, ...tailPush(logLines, maxLogLines, line))
        reindexJob.log_tail = logLines.join('\n').slice(-20000)
        continue
      }

      const chunks = chunkFileContent(relPath, fileText, { maxChars: chunkSize, overlapLines })
      if (!reindexJob || reindexJob.id !== jobId) return
      if (reindexJob.progress) {
        reindexJob.progress.total_chunks += chunks.length
        reindexJob.progress.current_file = relPath
        reindexJob.progress.last_update_at = nowS()
      }

      const lang = detectLanguage(relPath)
      let chunksEmbebidos = 0

      const grupoIndices: number[] = []
      const grupoTextos: string[] = []
      let grupoChars = 0

      const flushGrupo = async () => {
        if (!grupoIndices.length) return
        let embs: number[][] = []
        try {
          embs = await getEmbeddings(grupoTextos)
        } catch (e) {
          if (!reindexJob || reindexJob.id !== jobId) return
          if (reindexJob.progress) reindexJob.progress.errors += grupoIndices.length
          const line = `✗ ${relPath} (grupo ${grupoIndices[0]}-${grupoIndices[grupoIndices.length - 1]}): ${e instanceof Error ? e.message : String(e)}`
          logLines.splice(0, logLines.length, ...tailPush(logLines, maxLogLines, line))
          reindexJob.log_tail = logLines.join('\n').slice(-20000)
          grupoIndices.splice(0, grupoIndices.length)
          grupoTextos.splice(0, grupoTextos.length)
          grupoChars = 0
          return
        }

        for (let localI = 0; localI < grupoIndices.length; localI++) {
          const chunkI = grupoIndices[localI]!
          const chunk = chunks[chunkI]!
          const embedding = embs[localI]!
          const safeSymbol = chunk.nombre ? chunk.nombre.replace(/[^a-zA-Z0-9_-]/g, '_') : 'chunk'
          const chunkId = `${relPath}::${chunk.linea_inicio}-${chunk.linea_fin}::${chunk.tipo}::${safeSymbol}${chunkI}`
          rows.push({
            id: chunkId,
            text: chunk.texto,
            cleanCode: chunk.codigo_puro,
            vector: embedding,
            archivo: relPath,
            linea_inicio: chunk.linea_inicio,
            linea_fin: chunk.linea_fin,
            filePath: relPath,
            startLine: chunk.linea_inicio,
            endLine: chunk.linea_fin,
            language: lang,
            chunkType: chunk.tipo,
            symbolName: chunk.nombre,
            scope: chunk.scope,
            signature: chunk.firma || '',
          })
          chunksEmbebidos += 1
          if (reindexJob && reindexJob.id === jobId && reindexJob.progress) {
            reindexJob.progress.indexed_chunks += 1
          }
          if (rows.length >= flushEvery) await flush()
        }

        grupoIndices.splice(0, grupoIndices.length)
        grupoTextos.splice(0, grupoTextos.length)
        grupoChars = 0
      }

      for (let i = 0; i < chunks.length; i++) {
        const t = chunks[i]!.texto
        const tChars = t.length
        if (grupoIndices.length && (grupoIndices.length >= embedGroupSize || grupoChars + tChars > embedGroupMaxChars)) {
          await flushGrupo()
        }
        grupoIndices.push(i)
        grupoTextos.push(t)
        grupoChars += tChars
      }
      await flushGrupo()

      if (!reindexJob || reindexJob.id !== jobId) return
      if (chunksEmbebidos > 0) {
        if (reindexJob.progress) reindexJob.progress.indexed_files += 1
      }
      if (reindexJob.progress) {
        reindexJob.progress.processed_files += 1
        if (reindexJob.progress.total_files != null) {
          reindexJob.progress.files_remaining = Math.max(0, reindexJob.progress.total_files - reindexJob.progress.processed_files)
        }
        reindexJob.progress.last_update_at = nowS()
      }

      const line = `✓ ${relPath} (${chunksEmbebidos}/${chunks.length} chunks funcionales)`
      logLines.splice(0, logLines.length, ...tailPush(logLines, maxLogLines, line))
      reindexJob.log_tail = logLines.join('\n').slice(-20000)

      if (flushAfterEachFile && rows.length) await flush()
    }

    if (reindexJob && reindexJob.id === jobId && reindexJob.progress) {
      reindexJob.progress.processed_files = files.length
      reindexJob.progress.files_remaining = 0
      reindexJob.progress.current_file = null
      reindexJob.progress.last_update_at = nowS()
    }

    await flush()

    if (table && envBool('LANCEDB_CREATE_VECTOR_INDEX', true)) {
      await table.createIndex('vector').catch(() => {})
    }

    if (!reindexJob || reindexJob.id !== jobId) return
    const totalIndexed = reindexJob.progress?.indexed_chunks || 0
    const totalErrors = reindexJob.progress?.errors || 0

    if (totalIndexed === 0 && totalErrors > 0) {
      reindexJob.status = 'failed'
      reindexJob.finished_at = nowS()
      reindexJob.exit_code = 1
      reindexJob.error = `No se indexó ningún fragmento (${totalErrors} errores). Revisa tu proveedor de embeddings o los logs.`
    } else {
      reindexJob.status = 'completed'
      reindexJob.finished_at = nowS()
      reindexJob.exit_code = 0
      await updateProjectStats(targetProject.id, {
        totalChunks: totalIndexed,
        uniqueFiles: files.length,
        lastActiveAt: Date.now(),
      }).catch(() => {})

      const allProjects = await getAllProjects()
      broadcastEvent({
        action: 'projects_changed',
        activeProjectId: targetProject.id,
        project: targetProject,
        projects: allProjects,
      })
      broadcastEvent({
        action: 'reindex_completed',
        projectId: targetProject.id,
        projectName: targetProject.name,
        totalChunks: totalIndexed,
        uniqueFiles: files.length,
      })
      recordAgentActivity({
        agentName: 'MCP / Reindexer',
        action: 'reindex_project',
        projectId: targetProject.id,
        projectName: targetProject.name,
        projectPath: targetProject.path,
        details: `Indexación finalizada: ${totalIndexed} fragmentos en ${files.length} archivos`,
      })
    }
  } catch (e) {
    if (!reindexJob || reindexJob.id !== jobId) return
    reindexJob.status = 'failed'
    reindexJob.finished_at = nowS()
    reindexJob.exit_code = 1
    reindexJob.error = e instanceof Error ? e.message : String(e)
  } finally {
    reindexBusy = false
  }
}

async function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse) {
  json(res, 200, { status: 'ok' })
}

async function handleStats(_req: http.IncomingMessage, res: http.ServerResponse, url?: URL) {
  const projParam = url ? (url.searchParams.get('project') || url.searchParams.get('projectId') || url.searchParams.get('project_path')) : null
  const projects = await getAllProjects()
  const activeProj = await getActiveProject()
  let targetProj: ProjectRecord | null = null
  if (projParam) {
    targetProj = await resolveProjectTarget(projParam).catch(() => null)
  }
  if (!targetProj) targetProj = activeProj

  const settings = await loadSettingsSnapshot()
  const projectDir = targetProj ? targetProj.path : (settings.get('PROJECT_PATH') || '')
  const topKDefault = envInt('SEARCH_TOP_K', 5)
  const tableName = targetProj ? targetProj.tableName : ((settings.get('CHROMA_COLLECTION') || 'proyecto_index').trim() || 'proyecto_index')

  let totalChunks = targetProj?.totalChunks ?? 0
  let embeddingDim: number | null = null
  let uniqueFiles: number | null = targetProj?.uniqueFiles ?? null

  try {
    const db = await getDb()
    const tbl = await openTableOrNull(db, tableName)
    if (tbl) {
      totalChunks = await tbl.countRows()
      const sample = await tbl.query().select(['vector']).limit(1).toArray()
      const v = sample?.[0]?.vector
      if (Array.isArray(v)) embeddingDim = v.length

      if (uniqueFiles == null) {
        try {
          const maxRecords = envInt('STATS_MAX_RECORDS', 50000)
          const limit = Math.min(totalChunks, maxRecords)
          const page = 2000
          const seen = new Set<string>()
          let offset = 0
          while (offset < limit) {
            const rows = await tbl.query().select(['filePath', 'archivo']).offset(offset).limit(Math.min(page, limit - offset)).toArray()
            for (const r of rows) {
              const ruta = (r?.filePath || r?.archivo) as string | undefined
              if (ruta) seen.add(String(ruta))
            }
            offset += page
          }
          uniqueFiles = seen.size
        } catch {
          uniqueFiles = null
        }
      }
      if (targetProj) {
        void updateProjectStats(targetProj.id, { totalChunks, uniqueFiles: uniqueFiles ?? undefined }).catch(() => {})
      }
    }
  } catch {
    totalChunks = 0
  }

  let providerDim: number | null = null
  try {
    const prov = await getActiveEmbeddingProvider()
    providerDim = prov.getDimension()
  } catch {}

  json(res, 200, {
    status: 'ok',
    projects,
    active_project: activeProj,
    current_project: targetProj,
    collection: tableName,
    total_chunks: totalChunks,
    unique_files: uniqueFiles,
    embedding_provider: (settings.get('EMBEDDING_PROVIDER') || process.env.EMBEDDING_PROVIDER || 'local').trim().toLowerCase(),
    embedding_dim: embeddingDim,
    provider_dim: providerDim,
    dimension_mismatch: Boolean(embeddingDim && providerDim && embeddingDim !== providerDim),
    project_dir: projectDir || '',
    index_extensions: process.env.INDEX_EXTENSIONS || null,
    index_ignore_dirs: process.env.INDEX_IGNORE_DIRS || null,
    search_top_k_default: topKDefault,
  })
}

async function handleReindexStart(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<ReindexRequest & { project?: string; project_path?: string }>(req)
  if (!body.confirmar) {
    json(res, 200, { status: 'needs_confirmation', message: 'Envía confirmar=true para iniciar la reindexación.' })
    return
  }

  if (reindexJob && (reindexJob.status === 'queued' || reindexJob.status === 'running')) {
    json(res, 200, { status: 'already_running', job: snapshotJob(reindexJob) })
    return
  }

  if (reindexBusy) {
    json(res, 200, { status: 'already_running', job: reindexJob ? snapshotJob(reindexJob) : null })
    return
  }

  let targetProject: ProjectRecord
  try {
    targetProject = await resolveProjectTarget(body.project || body.project_path)
  } catch (e) {
    return json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
  }

  // Notificar inmediatamente la creación/activación del proyecto para el reindexado
  const allProjects = await getAllProjects()
  broadcastEvent({
    action: 'projects_changed',
    activeProjectId: targetProject.id,
    project: targetProject,
    projects: allProjects,
  })

  const jobId = randomUUID()
  reindexJob = {
    id: jobId,
    status: 'queued',
    created_at: nowS(),
    started_at: null,
    finished_at: null,
    exit_code: null,
    error: null,
    log_tail: '',
    progress: null,
    projectId: targetProject.id,
    projectName: targetProject.name,
    projectPath: targetProject.path,
  }
  reindexBusy = true
  void runReindexJob(jobId)
  json(res, 200, { status: 'started', job_id: jobId, project: targetProject })
}

async function handleReindexStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
  if (!reindexJob) {
    json(res, 200, { status: 'no_job' })
    return
  }
  json(res, 200, { status: 'ok', job: snapshotJob(reindexJob) })
}

export async function executeSearch(query: string, topK: number = 5, projectTarget?: string): Promise<{
  chunks: Array<{
    archivo: string
    linea_inicio: number | null
    linea_fin: number | null
    relevancia: number
    contenido: string
    codigo_puro?: string
    tipo?: string
    nombre?: string
    scope?: string
    firma?: string
  }>
  contextoParts: string[]
  warning?: string
  project: ProjectRecord
}> {
  const project = await resolveProjectTarget(projectTarget)
  const db = await getDb()
  const tableName = project.tableName
  const tbl = await openTableOrNull(db, tableName)
  if (!tbl) {
    return {
      chunks: [],
      contextoParts: [],
      warning: `No existe índice creado aún para "${project.name}". Haz clic en Reindexar.`,
      project,
    }
  }

  const count = await tbl.countRows().catch(() => 0)
  if (count === 0) {
    return {
      chunks: [],
      contextoParts: [],
      warning: `El índice de "${project.name}" está vacío (0 chunks).`,
      project,
    }
  }

  // Comprobar la dimensión real de los vectores almacenados en la tabla del proyecto
  let tableDim: number | null = null
  try {
    const sample = await tbl.query().select(['vector']).limit(1).toArray()
    const v = sample?.[0]?.vector
    if (Array.isArray(v) && v.length > 0) tableDim = v.length
  } catch {}

  let qEmb = await getQueryEmbedding(query)
  if (!qEmb) {
    return { chunks: [], contextoParts: [], project }
  }

  // Compatibilidad inteligente de dimensiones (MRL)
  if (tableDim && qEmb.length !== tableDim) {
    if (qEmb.length > tableDim) {
      // Truncar y renormalizar usando Matryoshka Representation Learning
      qEmb = applyMrlAndNormalize(qEmb, tableDim)
    } else {
      throw new Error(
        `Incompatibilidad de dimensiones: El índice de "${project.name}" está en ${tableDim}D, pero el modelo activo genera ${qEmb.length}D. Haz clic en "Indexar" para actualizar el proyecto.`
      )
    }
  }

  let rows: any[] = []
  try {
    rows = await tbl
      .query()
      .nearestTo(qEmb)
      .limit(topK)
      .toArray()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.toLowerCase().includes('dimension') || msg.toLowerCase().includes('length')) {
      throw new Error(
        `Incompatibilidad de dimensiones del vector para "${project.name}" (${tableDim ? tableDim + 'D' : ''}). Por favor reindexa el proyecto.`
      )
    }
    throw err
  }

  const chunks: Array<{
    archivo: string
    linea_inicio: number | null
    linea_fin: number | null
    relevancia: number
    contenido: string
    codigo_puro?: string
    tipo?: string
    nombre?: string
    scope?: string
    firma?: string
  }> = []
  const contextoParts: string[] = []

  for (const r of rows) {
    const archivo = String(r?.filePath || r?.archivo || '')
    const linea_inicio = (r?.startLine ?? r?.linea_inicio) as number | null
    const linea_fin = (r?.endLine ?? r?.linea_fin) as number | null
    const contenido = String(r?.text || '')
    const codigo_puro = String(r?.cleanCode || r?.text || '')
    const tipo = String(r?.chunkType || 'block')
    const nombre = String(r?.symbolName || '')
    const scope = String(r?.scope || '')
    const firma = String(r?.signature || '')
    const dist = typeof r?._distance === 'number' ? r._distance : null
    const relevancia = dist == null ? 0 : 1 / (1 + Math.max(0, dist))

    chunks.push({
      archivo,
      linea_inicio,
      linea_fin,
      relevancia: Math.round(relevancia * 1000) / 1000,
      contenido,
      codigo_puro,
      tipo,
      nombre,
      scope,
      firma,
    })

    if (archivo && contenido) {
      const badge = tipo && tipo !== 'block' ? `[${tipo.toUpperCase()}${nombre ? `: ${nombre}` : ''}] ` : ''
      contextoParts.push(`[${archivo} L${linea_inicio ?? '?'}-${linea_fin ?? '?'} ${badge}]\n${contenido}`)
    }
  }

  void updateProjectStats(project.id, {
    lastSearchQuery: query,
    lastSearchAt: Date.now(),
    lastActiveAt: Date.now(),
  }).catch(() => {})

  return { chunks, contextoParts, project }
}

export async function reindexSingleFile(relOrAbsPath: string, projectTarget?: string): Promise<{
  success: boolean
  filePath: string
  chunksCount: number
  error?: string
  project?: ProjectRecord
}> {
  let project: ProjectRecord
  try {
    project = await resolveProjectTarget(projectTarget)
  } catch (e) {
    return { success: false, filePath: relOrAbsPath, chunksCount: 0, error: e instanceof Error ? e.message : String(e) }
  }

  const projectDir = project.path
  let absPath = relOrAbsPath
  let relPath = relOrAbsPath
  if (path.isAbsolute(relOrAbsPath)) {
    relPath = path.relative(projectDir, relOrAbsPath).replace(/\\/g, '/')
  } else {
    absPath = path.join(projectDir, relOrAbsPath)
    relPath = relOrAbsPath.replace(/\\/g, '/')
  }

  let fileText = ''
  try {
    fileText = await fs.readFile(absPath, 'utf8')
  } catch (e) {
    return { success: false, filePath: relPath, chunksCount: 0, error: `No se pudo leer archivo: ${e instanceof Error ? e.message : String(e)}`, project }
  }

  const db = await getDb()
  const tableName = project.tableName
  let table = await openTableOrNull(db, tableName)

  const escaped = relPath.replace(/'/g, "''")
  if (table) {
    await table.delete(`filePath = '${escaped}'`).catch(() => {})
  }

  if (fileText.trim().length < 30) {
    return { success: true, filePath: relPath, chunksCount: 0, project }
  }

  const chunkSize = envInt('CHUNK_SIZE', 1200)
  const overlapLines = envInt('CHUNK_OVERLAP_LINES', 8)
  const lang = detectLanguage(relPath)
  const chunks = chunkFileContent(relPath, fileText, { maxChars: chunkSize, overlapLines })
  if (!chunks.length) return { success: true, filePath: relPath, chunksCount: 0, project }

  const embs = await getEmbeddings(chunks.map((c) => c.texto))
  const rows: any[] = []

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const embedding = embs[i]!
    const safeSymbol = chunk.nombre ? chunk.nombre.replace(/[^a-zA-Z0-9_-]/g, '_') : 'chunk'
    const chunkId = `${relPath}::${chunk.linea_inicio}-${chunk.linea_fin}::${chunk.tipo}::${safeSymbol}${i}`
    rows.push({
      id: chunkId,
      text: chunk.texto,
      cleanCode: chunk.codigo_puro,
      vector: embedding,
      archivo: relPath,
      linea_inicio: chunk.linea_inicio,
      linea_fin: chunk.linea_fin,
      filePath: relPath,
      startLine: chunk.linea_inicio,
      endLine: chunk.linea_fin,
      language: lang,
      chunkType: chunk.tipo,
      symbolName: chunk.nombre,
      scope: chunk.scope,
      signature: chunk.firma || '',
    })
  }

  if (!table) {
    table = await db.createTable(tableName, rows, { mode: 'overwrite' } as any)
  } else {
    try {
      await table.add(rows)
    } catch {
      await resetTable(db, tableName).catch(() => {})
      table = await db.createTable(tableName, rows, { mode: 'overwrite' } as any)
    }
  }

  if (table) {
    const totalCount = await table.countRows().catch(() => null)
    if (typeof totalCount === 'number') {
      void updateProjectStats(project.id, { totalChunks: totalCount, lastActiveAt: Date.now() }).catch(() => {})
    } else {
      void updateProjectStats(project.id, { lastActiveAt: Date.now() }).catch(() => {})
    }
  } else {
    void updateProjectStats(project.id, { lastActiveAt: Date.now() }).catch(() => {})
  }

  const allProjects = await getAllProjects()
  broadcastEvent({
    action: 'projects_changed',
    activeProjectId: project.id,
    project,
    projects: allProjects,
  })

  return { success: true, filePath: relPath, chunksCount: chunks.length, project }
}

async function handleBuscar(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<BuscarRequest & { agent_name?: string }>(req)
  const query = String(body.query || '').trim()
  if (!query) {
    json(res, 400, { ok: false, error: 'Falta query' })
    return
  }

  const topKDefault = envInt('SEARCH_TOP_K', 5)
  const topK = typeof body.top_k === 'number' && Number.isFinite(body.top_k) ? Math.max(1, Math.min(200, Math.trunc(body.top_k))) : topKDefault
  const usarRag = Boolean(body.usar_rag)
  const projectTarget = body.project || body.project_path

  let searchRes: Awaited<ReturnType<typeof executeSearch>>
  try {
    searchRes = await executeSearch(query, topK, projectTarget)
  } catch (e) {
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
  }

  const { chunks, contextoParts, warning, project } = searchRes

  if (body.agent_name) {
    recordAgentActivity({
      agentName: body.agent_name,
      action: 'search',
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      query,
      chunksFound: chunks.length,
      chunks,
      details: `${chunks.length} fragmentos recuperados para "${query}"`,
    })
  }

  let respuesta: string | null = null
  if (usarRag && contextoParts.length) {
    try {
      respuesta = await groqChat(query, contextoParts.join('\n\n'))
    } catch {
      respuesta = null
    }
  }

  json(res, 200, { query, chunks, respuesta, warning, project })
}

async function handleAgentSearch(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<{ query: string; top_k?: number; agent_name?: string; project_path?: string }>(req)
  const query = String(body.query || '').trim()
  if (!query) return json(res, 400, { ok: false, error: 'Falta query' })

  const topK = typeof body.top_k === 'number' && Number.isFinite(body.top_k) ? Math.max(1, Math.min(100, Math.trunc(body.top_k))) : 5
  const agentName = String(body.agent_name || 'Agente IA (MCP)').trim()
  const projectTarget = body.project_path

  let searchRes: Awaited<ReturnType<typeof executeSearch>>
  try {
    searchRes = await executeSearch(query, topK, projectTarget)
  } catch (e) {
    return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
  }

  const { chunks, warning, project } = searchRes

  recordAgentActivity({
    agentName,
    action: 'search',
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    query,
    chunksFound: chunks.length,
    chunks,
    details: `${chunks.length} fragmentos recuperados para "${query}" [${project.name}]`,
  })

  json(res, 200, { ok: true, query, chunks, warning, project })
}

async function handleAgentStoreMemory(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<{
    key: string
    content: string
    summary?: string
    tags?: string[]
    file_path?: string
    project_path?: string
    agent_name?: string
  }>(req)
  const agentName = String(body.agent_name || 'Agente IA (MCP)').trim()

  let project: ProjectRecord | null = null
  try {
    project = await resolveProjectTarget(body.project_path)
  } catch {}

  const mem = await storeMemory({
    key: body.key,
    content: body.content,
    summary: body.summary,
    tags: body.tags,
    filePath: body.file_path,
    projectId: project?.id,
  })

  recordAgentActivity({
    agentName,
    action: 'store_memory',
    projectId: project?.id,
    projectName: project?.name,
    projectPath: project?.path,
    key: mem.key,
    filePath: mem.filePath || undefined,
    details: `[${project?.name || 'Global'}] Guardado en memoria [${mem.key}]: "${mem.summary}"`,
    tokensSaved: mem.tokensEstimated,
  })

  json(res, 200, { ok: true, memory: mem, project })
}

async function handleAgentRecallMemory(_req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const query = url.searchParams.get('q') || url.searchParams.get('query') || ''
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam ? Number(limitParam) || 5 : 5
  const agentName = url.searchParams.get('agent_name') || 'Agente IA (MCP)'
  const projectTarget = url.searchParams.get('project_path') || url.searchParams.get('project')

  let project: ProjectRecord | null = null
  if (projectTarget) {
    project = await resolveProjectTarget(projectTarget).catch(() => null)
  } else {
    project = await getActiveProject().catch(() => null)
  }

  if (!query) {
    const list = await listMemories(project?.id)
    return json(res, 200, { ok: true, ...list, project })
  }

  const result = await recallMemories(query, limit, project?.id)

  recordAgentActivity({
    agentName,
    action: 'recall_memory',
    projectId: project?.id,
    projectName: project?.name,
    projectPath: project?.path,
    query,
    details: `[${project?.name || 'Global'}] Recuperadas ${result.memories.length} memorias para "${query}" (${result.tokensSavedNow} tokens ahorrados)`,
    tokensSaved: result.tokensSavedNow,
  })

  json(res, 200, { ok: true, query, ...result, project })
}

async function handleAgentDeleteMemory(_req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const key = url.searchParams.get('key') || url.searchParams.get('id') || ''
  const projectTarget = url.searchParams.get('project_path') || url.searchParams.get('project')
  const project = projectTarget ? await resolveProjectTarget(projectTarget).catch(() => null) : null
  if (!key) return json(res, 400, { ok: false, error: 'Falta key o id' })
  const ok = await deleteMemory(key, project?.id)
  json(res, 200, { ok })
}

async function handleAgentReindexFile(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<{ file_path: string; project_path?: string; agent_name?: string }>(req)
  const filePath = String(body.file_path || '').trim()
  if (!filePath) return json(res, 400, { ok: false, error: 'Falta file_path' })
  const agentName = String(body.agent_name || 'Agente IA (MCP)').trim()

  const result = await reindexSingleFile(filePath, body.project_path)

  recordAgentActivity({
    agentName,
    action: 'reindex_file',
    projectId: result.project?.id,
    projectName: result.project?.name,
    projectPath: result.project?.path,
    filePath,
    details: result.success ? `[${result.project?.name || 'Proyecto'}] Reindexado: ${result.chunksCount} chunks` : `Error: ${result.error}`,
  })

  json(res, result.success ? 200 : 500, result)
}

async function handleGetProjects(_req: http.IncomingMessage, res: http.ServerResponse) {
  const projects = await getAllProjects()
  const active = await getActiveProject()
  json(res, 200, { ok: true, projects, activeProject: active })
}

async function handleAddProject(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<{ path: string; name?: string }>(req)
  const rawPath = String(body.path || '').trim()
  if (!rawPath) return json(res, 400, { ok: false, error: 'Falta path' })
  const proj = await registerOrGetProject(rawPath, body.name)
  await setActiveProject(proj.id)
  const all = await getAllProjects()
  broadcastEvent({
    action: 'projects_changed',
    activeProjectId: proj.id,
    project: proj,
    projects: all,
  })
  json(res, 200, { ok: true, project: proj })
}

async function handleSetActiveProject(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<{ id: string }>(req)
  const id = String(body.id || '').trim()
  if (!id) return json(res, 400, { ok: false, error: 'Falta id' })
  const proj = await setActiveProject(id)
  if (!proj) return json(res, 404, { ok: false, error: 'Proyecto no encontrado' })
  const all = await getAllProjects()
  broadcastEvent({
    action: 'projects_changed',
    activeProjectId: proj.id,
    project: proj,
    projects: all,
  })
  json(res, 200, { ok: true, project: proj })
}

async function handleDeleteProject(_req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const id = url.searchParams.get('id') || ''
  if (!id) return json(res, 400, { ok: false, error: 'Falta id' })
  const ok = await removeProject(id)
  const all = await getAllProjects()
  const active = await getActiveProject()
  broadcastEvent({
    action: 'projects_changed',
    activeProjectId: active?.id || null,
    projects: all,
  })
  json(res, 200, { ok })
}

async function handleSetProjectPath(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJsonBody<{ projectPath?: string | null }>(req)
  const projectPath = body.projectPath == null ? null : String(body.projectPath).trim()
  let proj: ProjectRecord | null = null
  if (projectPath != null) {
    process.env.PROJECT_PATH = projectPath
    proj = await registerOrGetProject(projectPath)
  }
  const ui = await updateSettingsUi({ values: { PROJECT_PATH: projectPath && projectPath.length ? projectPath : '' } })
  const all = await getAllProjects()
  broadcastEvent({
    action: 'projects_changed',
    activeProjectId: proj?.id || null,
    project: proj || undefined,
    projects: all,
  })
  json(res, 200, { ok: true, projectPath: ui.values.PROJECT_PATH || null })
}

let currentModelDownload: Promise<string> | null = null
let currentDownloadProgress: any = null

async function handleGetModelStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
  const status = await checkLocalModelStatus()
  json(res, 200, {
    ok: true,
    ...status,
    downloading: Boolean(currentModelDownload),
    progress: currentDownloadProgress,
  })
}

async function handlePostModelDownload(_req: http.IncomingMessage, res: http.ServerResponse) {
  const status = await checkLocalModelStatus()
  if (status.installed) {
    return json(res, 200, { ok: true, status: 'ready', message: 'El modelo ya está instalado y listo.' })
  }

  if (currentModelDownload) {
    return json(res, 200, {
      ok: true,
      status: 'downloading',
      message: 'Descarga ya en progreso.',
      progress: currentDownloadProgress,
    })
  }

  currentModelDownload = downloadLocalModel((p) => {
    currentDownloadProgress = p
    broadcastEvent({
      action: 'model_progress',
      progress: p.progress,
      status: p.status,
      message: p.message,
    })
  })
    .then((dir) => {
      currentModelDownload = null
      currentDownloadProgress = { status: 'ready', progress: 100, message: 'Modelo descargado y listo.' }
      broadcastEvent({
        action: 'model_progress',
        progress: 100,
        status: 'ready',
        message: 'Modelo EmbeddingGemma descargado y listo.',
      })
      return dir
    })
    .catch((err) => {
      currentModelDownload = null
      currentDownloadProgress = { status: 'error', progress: 0, message: err.message }
      broadcastEvent({
        action: 'model_progress',
        progress: 0,
        status: 'error',
        message: `Error al descargar modelo: ${err.message}`,
      })
      throw err
    })

  json(res, 200, { ok: true, status: 'downloading', message: 'Descarga de EmbeddingGemma iniciada.' })
}

async function handleTestEmbeddingProvider(_req: http.IncomingMessage, res: http.ServerResponse) {
  const t0 = performance.now()
  try {
    const prov = await getActiveEmbeddingProvider()
    const sample = await prov.embedQuery('function testVerification()')
    const t1 = performance.now()
    if (!Array.isArray(sample) || sample.length === 0) {
      return json(res, 400, { ok: false, error: 'El proveedor no generó un vector válido.' })
    }
    const settings = await loadSettingsSnapshot()
    const provider = (settings.get('EMBEDDING_PROVIDER') || process.env.EMBEDDING_PROVIDER || 'gemma-local').trim().toLowerCase()
    return json(res, 200, {
      ok: true,
      provider,
      dimension: sample.length,
      timeMs: Math.round(t1 - t0),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return json(res, 400, { ok: false, error: msg })
  }
}

export async function getBackendConfig() {
  const ui = await getSettingsUi()
  const p = String(ui.values.PROJECT_PATH || '').trim()
  const out: BackendConfig = { projectPath: p ? p : null }
  return out
}

export async function setBackendProjectPath(projectPath: string | null) {
  const pTrim = projectPath && projectPath.trim() ? projectPath.trim() : ''
  process.env.PROJECT_PATH = pTrim
  if (pTrim) await registerOrGetProject(pTrim)
  const ui = await updateSettingsUi({ values: { PROJECT_PATH: pTrim } })
  const p = String(ui.values.PROJECT_PATH || '').trim()
  const out: BackendConfig = { projectPath: p ? p : null }
  return out
}

export type BackendServer = {
  port: number
  url: string
  close: () => Promise<void>
}

export async function startBackendServer(preferredPort: number = DEFAULT_PORT): Promise<BackendServer> {
  const candidatePorts = [
    preferredPort,
    ...CANDIDATE_PORTS.filter((p) => p !== preferredPort),
  ]

  let boundServer: http.Server | null = null
  let boundPort: number | null = null

  for (const port of candidatePorts) {
    try {
      const server = http.createServer(async (req, res) => {
        try {
          const method = (req.method || 'GET').toUpperCase()
          if (method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            })
            res.end()
            return
          }

          const u = new URL(req.url || '/', `http://127.0.0.1:${port}`)
          const pathname = u.pathname

          if (method === 'GET' && pathname === '/health') return await handleHealth(req, res)
          if (method === 'GET' && pathname === '/stats') return await handleStats(req, res, u)
          if (pathname === '/reindexar' && method === 'POST') return await handleReindexStart(req, res)
          if (pathname === '/reindexar' && method === 'GET') return await handleReindexStatus(req, res)
          if (pathname === '/buscar' && method === 'POST') return await handleBuscar(req, res)
          if (pathname === '/config/project' && method === 'POST') return await handleSetProjectPath(req, res)
          if (method === 'GET' && pathname === '/mcp/info') {
            const root = process.env.APP_ROOT || process.cwd()
            const mcpServerPath = path.resolve(root, 'mcp-server.cjs')
            return json(res, 200, {
              ok: true,
              mcpServerPath,
              backendUrl: `http://127.0.0.1:${port}`,
              port,
            })
          }
          if (method === 'GET' && pathname === '/settings') {
            return json(res, 200, await getSettingsUi())
          }
          if (method === 'POST' && pathname === '/settings') {
            const body = await readJsonBody<any>(req)
            return json(res, 200, await updateSettingsUi(body))
          }

          // Local Model Management Endpoints
          if (method === 'GET' && pathname === '/model/status') return await handleGetModelStatus(req, res)
          if (method === 'POST' && pathname === '/model/download') return await handlePostModelDownload(req, res)
          if (method === 'POST' && pathname === '/model/test') return await handleTestEmbeddingProvider(req, res)

          // Project Management Endpoints
          if (method === 'GET' && pathname === '/projects') return await handleGetProjects(req, res)
          if (method === 'POST' && pathname === '/projects') return await handleAddProject(req, res)
          if (method === 'POST' && pathname === '/projects/active') return await handleSetActiveProject(req, res)
          if (method === 'DELETE' && pathname === '/projects') return await handleDeleteProject(req, res, u)

          // Agent & MCP Live Endpoints
          if (method === 'GET' && pathname === '/agent/events') return registerSseClient(req, res)
          if (method === 'GET' && pathname === '/agent/activity') {
            const pId = u.searchParams.get('project') || u.searchParams.get('projectId') || undefined
            return json(res, 200, { ok: true, events: getRecentActivity(50, pId), lastSearch: getLastAgentSearch(pId) })
          }
          if (method === 'POST' && pathname === '/agent/search') return await handleAgentSearch(req, res)
          if (method === 'POST' && pathname === '/agent/memory') return await handleAgentStoreMemory(req, res)
          if (method === 'GET' && pathname === '/agent/memory') return await handleAgentRecallMemory(req, res, u)
          if (method === 'DELETE' && pathname === '/agent/memory') return await handleAgentDeleteMemory(req, res, u)
          if (method === 'POST' && pathname === '/agent/reindex-file') return await handleAgentReindexFile(req, res)

          json(res, 404, { ok: false, error: 'Not found' })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          json(res, 500, { ok: false, error: msg })
        }
      })

      await new Promise<void>((resolve, reject) => {
        const onError = (err: any) => {
          server.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })

      boundServer = server
      boundPort = port
      console.log(`[GraphMap Backend] Servidor iniciado exitosamente en puerto ${port}`)
      break
    } catch (err: any) {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        console.warn(`[GraphMap Backend] Puerto ${port} ocupado, intentando puerto auxiliar...`)
        continue
      }
      throw err
    }
  }

  if (!boundServer || !boundPort) {
    throw new Error(
      `No se pudo iniciar el backend. Todos los puertos candidatos (${candidatePorts.join(', ')}) están ocupados.`,
    )
  }

  process.env.BACKEND_PORT = String(boundPort)
  process.env.BACKEND_URL = `http://127.0.0.1:${boundPort}`

  const url = `http://127.0.0.1:${boundPort}`
  return {
    port: boundPort,
    url,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        boundServer!.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

