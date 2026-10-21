import path from 'node:path'
import fs from 'node:fs/promises'
import { app, safeStorage } from 'electron'

type SettingsFile = {
  public: Record<string, string>
  secrets: Record<string, string>
}

export type SettingsPublic = {
  GROQ_MODEL: string
  PROJECT_PATH: string
  EMBEDDING_PROVIDER: string
  GEMMA_LOCAL_DIMENSION: string
  GEMMA_API_URL: string
  GEMMA_MODEL_NAME: string
  GEMMA_BATCH_SIZE: string
  VOYAGE_EMBEDDING_MODEL: string
  VOYAGE_INPUT_TYPE: string
  VOYAGE_RATE_LIMIT_PROFILE: string
  VOYAGE_RPM: string
  VOYAGE_TPM: string
  VOYAGE_AUTO_BATCH: string
  CHROMA_COLLECTION: string
  RESET_CHROMA: string
  INDEX_EXTENSIONS: string
  INDEX_IGNORE_DIRS: string
  INDEX_IGNORE_FILES: string
  CHUNK_SIZE: string
  CHUNK_OVERLAP_LINES: string
  SEARCH_TOP_K: string
  REINDEX_TIMEOUT_S: string
  REINDEX_LOG_MAX_LINES: string
  FLUSH_EVERY: string
  FLUSH_AFTER_EACH_FILE: string
  EMBED_GROUP_SIZE: string
  EMBED_GROUP_MAX_CHARS: string
  STATS_MAX_RECORDS: string
}

export type SettingsUi = {
  values: Partial<SettingsPublic>
  hasSecrets: {
    GROQ_API_KEY: boolean
    VOYAGE_API_KEY: boolean
    GEMMA_API_KEY: boolean
  }
}

const SETTINGS_FILE = 'settings.json'

const DEFAULTS: SettingsPublic = {
  GROQ_MODEL: 'llama-3.3-70b-versatile',
  PROJECT_PATH: '',
  EMBEDDING_PROVIDER: 'gemma-local',
  GEMMA_LOCAL_DIMENSION: '512',
  GEMMA_API_URL: 'http://localhost:8000/v1',
  GEMMA_MODEL_NAME: 'google/embeddinggemma-270m',
  GEMMA_BATCH_SIZE: '32',
  VOYAGE_EMBEDDING_MODEL: 'voyage-code-3',
  VOYAGE_INPUT_TYPE: 'document',
  VOYAGE_RATE_LIMIT_PROFILE: 'free',
  VOYAGE_RPM: '3',
  VOYAGE_TPM: '10000',
  VOYAGE_AUTO_BATCH: 'true',
  CHROMA_COLLECTION: 'proyecto_index',
  RESET_CHROMA: 'false',
  INDEX_EXTENSIONS: '.php,.py,.ts,.js,.tsx,.jsx,.md,.json,.yaml,.yml,.env.example,.toml,.sh',
  INDEX_IGNORE_DIRS:
    'node_modules,vendor,storage,.git,dist,__pycache__,.next,build,venv,.venv,coverage,.pytest_cache,.trae,.idea,.vscode',
  INDEX_IGNORE_FILES:
    'CHANGELOG.md,CHANGELOG.MD,README.md,README.MD,*.log,*.lock,composer.lock,package-lock.json,yarn.lock,pnpm-lock.yaml,.phpunit.result.cache',
  CHUNK_SIZE: '1200',
  CHUNK_OVERLAP_LINES: '8',
  SEARCH_TOP_K: '5',
  REINDEX_TIMEOUT_S: '3600',
  REINDEX_LOG_MAX_LINES: '800',
  FLUSH_EVERY: '50',
  FLUSH_AFTER_EACH_FILE: 'true',
  EMBED_GROUP_SIZE: '16',
  EMBED_GROUP_MAX_CHARS: '12000',
  STATS_MAX_RECORDS: '50000',
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true })
}

async function settingsPath() {
  const dir = app.getPath('userData')
  await ensureDir(dir)
  return path.join(dir, SETTINGS_FILE)
}

function encryptString(value: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Almacenamiento seguro no disponible en este sistema.')
  }
  return safeStorage.encryptString(value).toString('base64')
}

function decryptString(valueB64: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Almacenamiento seguro no disponible en este sistema.')
  }
  return safeStorage.decryptString(Buffer.from(valueB64, 'base64'))
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function readFile(): Promise<SettingsFile> {
  const p = await settingsPath()
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<SettingsFile>
    return {
      public: typeof parsed.public === 'object' && parsed.public ? (parsed.public as Record<string, string>) : {},
      secrets: typeof parsed.secrets === 'object' && parsed.secrets ? (parsed.secrets as Record<string, string>) : {},
    }
  } catch {
    return { public: {}, secrets: {} }
  }
}

async function writeFile(next: SettingsFile) {
  const p = await settingsPath()
  const dir = path.dirname(p)
  const tmp = path.join(dir, `${SETTINGS_FILE}.${Date.now()}.tmp`)
  const payload = JSON.stringify(next, null, 2)

  const maxRetries = 8
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fs.writeFile(tmp, payload, 'utf8')
      try {
        await fs.rename(tmp, p)
      } catch (e: any) {
        const code = e?.code
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
          await fs.copyFile(tmp, p)
          await fs.unlink(tmp).catch(() => {})
        } else {
          throw e
        }
      }
      return
    } catch (e: any) {
      await fs.unlink(tmp).catch(() => {})
      const code = e?.code
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < maxRetries) {
        await sleep(40 * (attempt + 1))
        continue
      }
      throw e
    }
  }
}

function normalizePublicValue(_key: keyof SettingsPublic, v: unknown) {
  if (v == null) return ''
  return String(v)
}

export async function getSettingsUi(): Promise<SettingsUi> {
  const f = await readFile()
  const values: Partial<SettingsPublic> = {}
  for (const k of Object.keys(DEFAULTS) as Array<keyof SettingsPublic>) {
    const stored = f.public[k]
    const envV = process.env[k]
    const val = typeof stored === 'string' && stored.trim() ? stored : typeof envV === 'string' && envV.trim() ? envV : DEFAULTS[k]
    values[k] = val
  }
  return {
    values,
    hasSecrets: {
      GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()) || Boolean(f.secrets.GROQ_API_KEY),
      VOYAGE_API_KEY:
        Boolean(process.env.VOYAGE_API_KEY && process.env.VOYAGE_API_KEY.trim()) || Boolean(f.secrets.VOYAGE_API_KEY),
      GEMMA_API_KEY:
        Boolean(process.env.GEMMA_API_KEY && process.env.GEMMA_API_KEY.trim()) || Boolean(f.secrets.GEMMA_API_KEY),
    },
  }
}

export async function updateSettingsUi(patch: {
  values?: Partial<SettingsPublic>
  secrets?: Partial<{ GROQ_API_KEY: string; VOYAGE_API_KEY: string; GEMMA_API_KEY: string }>
}): Promise<SettingsUi> {
  const f = await readFile()
  const next: SettingsFile = { public: { ...f.public }, secrets: { ...f.secrets } }

  if (patch.values) {
    for (const k of Object.keys(patch.values) as Array<keyof SettingsPublic>) {
      const v = normalizePublicValue(k, patch.values[k])
      next.public[k] = v
      process.env[k] = v
    }
  }

  if (patch.secrets) {
    if (typeof patch.secrets.GROQ_API_KEY === 'string') {
      const val = patch.secrets.GROQ_API_KEY.trim().replace(/^["']|["']$/g, '')
      if (val) {
        next.secrets.GROQ_API_KEY = encryptString(val)
        process.env.GROQ_API_KEY = val
      } else {
        delete next.secrets.GROQ_API_KEY
        delete process.env.GROQ_API_KEY
      }
    }
    if (typeof patch.secrets.VOYAGE_API_KEY === 'string') {
      const val = patch.secrets.VOYAGE_API_KEY.trim().replace(/^["']|["']$/g, '')
      if (val) {
        next.secrets.VOYAGE_API_KEY = encryptString(val)
        process.env.VOYAGE_API_KEY = val
      } else {
        delete next.secrets.VOYAGE_API_KEY
        delete process.env.VOYAGE_API_KEY
      }
    }
    if (typeof patch.secrets.GEMMA_API_KEY === 'string') {
      const val = patch.secrets.GEMMA_API_KEY.trim().replace(/^["']|["']$/g, '')
      if (val) {
        next.secrets.GEMMA_API_KEY = encryptString(val)
        process.env.GEMMA_API_KEY = val
      } else {
        delete next.secrets.GEMMA_API_KEY
        delete process.env.GEMMA_API_KEY
      }
    }
  }

  await writeFile(next)
  return await getSettingsUi()
}

export async function getPublicValue(key: keyof SettingsPublic): Promise<string> {
  const f = await readFile()
  const stored = f.public[key]
  if (typeof stored === 'string' && stored.trim()) return stored
  const envV = process.env[key]
  if (typeof envV === 'string' && envV.trim()) return envV
  return DEFAULTS[key]
}

export async function getSecretValue(key: 'GROQ_API_KEY' | 'VOYAGE_API_KEY' | 'GEMMA_API_KEY'): Promise<string | null> {
  const f = await readFile()
  const enc = f.secrets[key]
  if (enc) {
    try {
      const decrypted = decryptString(enc).trim().replace(/^["']|["']$/g, '')
      if (decrypted) {
        process.env[key] = decrypted
        return decrypted
      }
    } catch {
      // safeStorage unavailable or corrupted
    }
  }
  const envV = process.env[key]
  if (typeof envV === 'string' && envV.trim()) {
    return envV.trim().replace(/^["']|["']$/g, '')
  }
  return null
}
