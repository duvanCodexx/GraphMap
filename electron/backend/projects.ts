import path from 'node:path'
import fs from 'node:fs/promises'
import { getSettingsUi, updateSettingsUi } from './settings'

export type ProjectRecord = {
  id: string
  name: string
  path: string
  tableName: string
  createdAt: number
  lastActiveAt: number
  totalChunks?: number
  uniqueFiles?: number
  lastSearchQuery?: string
  lastSearchAt?: number
}

export type ProjectChangeEvent = {
  action: 'projects_changed'
  activeProjectId?: string | null
  project?: ProjectRecord
}

type ProjectChangeListener = (event: ProjectChangeEvent) => void
const changeListeners: ProjectChangeListener[] = []

export function onProjectsChange(listener: ProjectChangeListener): () => void {
  changeListeners.push(listener)
  return () => {
    const idx = changeListeners.indexOf(listener)
    if (idx >= 0) changeListeners.splice(idx, 1)
  }
}

export function notifyProjectsChange(activeProjectId?: string | null, project?: ProjectRecord) {
  for (const fn of [...changeListeners]) {
    try {
      fn({ action: 'projects_changed', activeProjectId, project })
    } catch {}
  }
}

type ProjectsStore = {
  activeProjectId: string | null
  projects: ProjectRecord[]
}

let cachedProjects: ProjectsStore | null = null

function fnv1a(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function getStoragePath(): string {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'embeding-electron', 'projects.json')
  }
  return path.join(process.cwd(), 'projects.json')
}

export function canonicalizePath(p: string): string {
  if (!p) return ''
  let resolved = path.resolve(p)
  // Normalizar separadores a '/'
  resolved = resolved.replace(/\\/g, '/')
  // Eliminar slash final a menos que sea raíz
  if (resolved.length > 3 && resolved.endsWith('/')) {
    resolved = resolved.slice(0, -1)
  }
  return resolved
}

export function generateProjectId(canonicalPath: string): string {
  const base = path.basename(canonicalPath).replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() || 'proj'
  const hash = fnv1a(canonicalPath.toLowerCase()).toString(16)
  return `p_${base}_${hash}`
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true })
}

async function readStore(): Promise<ProjectsStore> {
  if (cachedProjects) return cachedProjects
  const file = getStoragePath()
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ProjectsStore>
    cachedProjects = {
      activeProjectId: parsed.activeProjectId || null,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    }
  } catch {
    cachedProjects = { activeProjectId: null, projects: [] }
  }

  // Si no hay proyectos pero settings.json tiene PROJECT_PATH, migrarlo
  if (cachedProjects.projects.length === 0) {
    try {
      const ui = await getSettingsUi()
      const existingPath = String(ui.values.PROJECT_PATH || '').trim()
      if (existingPath) {
        const cPath = canonicalizePath(existingPath)
        const id = generateProjectId(cPath)
        const name = path.basename(cPath) || 'Proyecto Principal'
        const initialProj: ProjectRecord = {
          id,
          name,
          path: cPath,
          tableName: `tbl_${id}`,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        }
        cachedProjects.projects.push(initialProj)
        cachedProjects.activeProjectId = id
        await writeStore(cachedProjects)
      }
    } catch {}
  }

  return cachedProjects
}

async function writeStore(store: ProjectsStore): Promise<void> {
  cachedProjects = store
  const file = getStoragePath()
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${Date.now()}.tmp`
  const data = JSON.stringify(store, null, 2)
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, file).catch(async () => {
    await fs.copyFile(tmp, file)
    await fs.unlink(tmp).catch(() => {})
  })
}

export async function getAllProjects(): Promise<ProjectRecord[]> {
  const store = await readStore()
  return [...store.projects].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

export async function getActiveProject(): Promise<ProjectRecord | null> {
  const store = await readStore()
  if (!store.projects.length) return null
  if (store.activeProjectId) {
    const found = store.projects.find((p) => p.id === store.activeProjectId)
    if (found) return found
  }
  return store.projects[0] || null
}

export async function setActiveProject(idOrPath: string): Promise<ProjectRecord | null> {
  const store = await readStore()
  const cTarget = canonicalizePath(idOrPath).toLowerCase()
  const found = store.projects.find(
    (p) => p.id === idOrPath || p.path.toLowerCase() === cTarget,
  )
  if (!found) return null

  const wasAlreadyActive = store.activeProjectId === found.id
  found.lastActiveAt = Date.now()
  store.activeProjectId = found.id
  await writeStore(store)

  // Sincronizar en settings.json para retrocompatibilidad
  await updateSettingsUi({ values: { PROJECT_PATH: found.path } }).catch(() => {})

  if (!wasAlreadyActive) {
    notifyProjectsChange(found.id, found)
  }

  return found
}

export async function registerOrGetProject(
  rawPath: string,
  customName?: string,
): Promise<ProjectRecord> {
  const store = await readStore()
  const cPath = canonicalizePath(rawPath)
  if (!cPath) throw new Error('Ruta de proyecto inválida')

  const existing = store.projects.find((p) => p.path.toLowerCase() === cPath.toLowerCase())
  if (existing) {
    existing.lastActiveAt = Date.now()
    if (customName && customName.trim() && existing.name !== customName.trim()) {
      existing.name = customName.trim()
    }
    const wasActive = store.activeProjectId === existing.id
    store.activeProjectId = existing.id
    await writeStore(store)
    if (!wasActive) {
      notifyProjectsChange(existing.id, existing)
    }
    return existing
  }

  const id = generateProjectId(cPath)
  const name = customName && customName.trim() ? customName.trim() : path.basename(cPath) || 'Proyecto'
  const newProject: ProjectRecord = {
    id,
    name,
    path: cPath,
    tableName: `tbl_${id}`,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  }

  store.projects.unshift(newProject)
  store.activeProjectId = id
  await writeStore(store)

  // Sincronizar con settings
  await updateSettingsUi({ values: { PROJECT_PATH: cPath } }).catch(() => {})

  notifyProjectsChange(id, newProject)
  return newProject
}

export async function getProject(idOrPath: string): Promise<ProjectRecord | null> {
  const store = await readStore()
  if (!idOrPath) return null
  const cTarget = canonicalizePath(idOrPath).toLowerCase()
  return (
    store.projects.find((p) => p.id === idOrPath || p.path.toLowerCase() === cTarget) || null
  )
}

export async function updateProjectStats(
  id: string,
  stats: Partial<ProjectRecord>,
): Promise<void> {
  const store = await readStore()
  const p = store.projects.find((x) => x.id === id)
  if (p) {
    Object.assign(p, stats)
    await writeStore(store)
  }
}

export async function removeProject(id: string): Promise<boolean> {
  const store = await readStore()
  const idx = store.projects.findIndex((p) => p.id === id)
  if (idx < 0) return false
  store.projects.splice(idx, 1)
  if (store.activeProjectId === id) {
    store.activeProjectId = store.projects[0]?.id || null
  }
  await writeStore(store)
  notifyProjectsChange(store.activeProjectId)
  return true
}
