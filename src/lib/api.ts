import type {
  BuscarRequest,
  BuscarResponse,
  HealthResponse,
  ProjectRecord,
  ProjectsResponse,
  ReindexStartResponse,
  ReindexStatusResponse,
  StatsResponse,
} from './types'

export class ApiError extends Error {
  status: number | null
  bodyText: string | null

  constructor(message: string, status: number | null, bodyText: string | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.bodyText = bodyText
  }
}

async function safeReadText(res: Response): Promise<string | null> {
  try {
    return await res.text()
  } catch {
    return null
  }
}

export async function apiGet<T>(baseUrl: string, path: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, { method: 'GET', signal })
  } catch (e) {
    throw new ApiError(String(e), null, null)
  }
  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status}`, res.status, await safeReadText(res))
  }
  return (await res.json()) as T
}

export async function apiPost<TReq, TRes>(
  baseUrl: string,
  path: string,
  body: TReq,
  signal?: AbortSignal,
): Promise<TRes> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    throw new ApiError(String(e), null, null)
  }
  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status}`, res.status, await safeReadText(res))
  }
  return (await res.json()) as TRes
}

export const Api = {
  health: (baseUrl: string, signal?: AbortSignal) => apiGet<HealthResponse>(baseUrl, '/health', signal),
  stats: (baseUrl: string, projectId?: string, signal?: AbortSignal) => {
    const q = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
    return apiGet<StatsResponse>(baseUrl, `/stats${q}`, signal)
  },
  getProjects: (baseUrl: string, signal?: AbortSignal) => apiGet<ProjectsResponse>(baseUrl, '/projects', signal),
  addProject: (baseUrl: string, path: string, name?: string, signal?: AbortSignal) =>
    apiPost<{ path: string; name?: string }, { ok: boolean; project: ProjectRecord }>(
      baseUrl,
      '/projects',
      { path, name },
      signal,
    ),
  setActiveProject: (baseUrl: string, id: string, signal?: AbortSignal) =>
    apiPost<{ id: string }, { ok: boolean; project: ProjectRecord }>(baseUrl, '/projects/active', { id }, signal),
  deleteProject: async (baseUrl: string, id: string, signal?: AbortSignal) => {
    let res: Response
    try {
      res = await fetch(`${baseUrl}/projects?id=${encodeURIComponent(id)}`, { method: 'DELETE', signal })
    } catch (e) {
      throw new ApiError(String(e), null, null)
    }
    if (!res.ok) {
      throw new ApiError(`HTTP ${res.status}`, res.status, await safeReadText(res))
    }
    return (await res.json()) as { ok: boolean }
  },
  reindexStart: (baseUrl: string, confirmar: boolean, project?: string, signal?: AbortSignal) =>
    apiPost<{ confirmar: boolean; project?: string }, ReindexStartResponse>(
      baseUrl,
      '/reindexar',
      { confirmar, project },
      signal,
    ),
  reindexStatus: (baseUrl: string, signal?: AbortSignal) => apiGet<ReindexStatusResponse>(baseUrl, '/reindexar', signal),
  buscar: (baseUrl: string, req: BuscarRequest, signal?: AbortSignal) =>
    apiPost<BuscarRequest, BuscarResponse>(baseUrl, '/buscar', req, signal),
  agentActivity: (baseUrl: string, projectId?: string, signal?: AbortSignal) => {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    return apiGet<{ ok: boolean; events: any[]; lastSearch: any }>(baseUrl, `/agent/activity${q}`, signal)
  },
  agentMemories: (baseUrl: string, projectId?: string, signal?: AbortSignal) => {
    const q = projectId ? `?project_path=${encodeURIComponent(projectId)}` : ''
    return apiGet<{ ok: boolean; memories: any[]; stats: any }>(baseUrl, `/agent/memory${q}`, signal)
  },
  deleteMemory: async (baseUrl: string, key: string, projectId?: string, signal?: AbortSignal) => {
    const p = projectId ? `&project_path=${encodeURIComponent(projectId)}` : ''
    let res: Response
    try {
      res = await fetch(`${baseUrl}/agent/memory?key=${encodeURIComponent(key)}${p}`, { method: 'DELETE', signal })
    } catch (e) {
      throw new ApiError(String(e), null, null)
    }
    if (!res.ok) {
      throw new ApiError(`HTTP ${res.status}`, res.status, await safeReadText(res))
    }
    return (await res.json()) as { ok: boolean }
  },
}


