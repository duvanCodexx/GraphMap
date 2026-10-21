import type http from 'node:http'
import { randomUUID } from 'node:crypto'

export type AgentActivityEvent = {
  id: string
  timestamp: number
  agentName: string
  action: 'search' | 'store_memory' | 'recall_memory' | 'reindex_file' | 'reindex_project'
  projectId?: string
  projectName?: string
  projectPath?: string
  query?: string
  key?: string
  filePath?: string
  chunksFound?: number
  chunks?: Array<{
    archivo: string
    linea_inicio: number | null
    linea_fin: number | null
    relevancia: number
    tipo?: string
    nombre?: string
    codigo_puro?: string
    contenido: string
    scope?: string
  }>
  details?: string
  tokensSaved?: number
}

const MAX_ACTIVITY_HISTORY = 120
const activityHistory: AgentActivityEvent[] = []
const sseClients = new Set<http.ServerResponse>()
const lastSearchByProject = new Map<string, AgentActivityEvent>()
let globalLastSearchEvent: AgentActivityEvent | null = null

export function recordAgentActivity(
  eventData: Omit<AgentActivityEvent, 'id' | 'timestamp'>,
): AgentActivityEvent {
  const event: AgentActivityEvent = {
    ...eventData,
    id: randomUUID(),
    timestamp: Date.now(),
  }

  activityHistory.unshift(event)
  if (activityHistory.length > MAX_ACTIVITY_HISTORY) {
    activityHistory.pop()
  }

  if (event.action === 'search' && Array.isArray(event.chunks)) {
    globalLastSearchEvent = event
    if (event.projectId) {
      lastSearchByProject.set(event.projectId, event)
    }
  }

  // Difundir evento a todos los clientes SSE conectados
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }

  return event
}

export function broadcastEvent(data: Record<string, any>): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
}

export function registerSseClient(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })

  // Enviar evento de bienvenida
  res.write(`data: ${JSON.stringify({ type: 'connected', clientsCount: sseClients.size + 1 })}\n\n`)

  sseClients.add(res)

  // Enviar ping cada 20 segundos para mantener la conexión viva
  const interval = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      clearInterval(interval)
      sseClients.delete(res)
    }
  }, 20000)

  req.on('close', () => {
    clearInterval(interval)
    sseClients.delete(res)
  })
}

export function getRecentActivity(limit = 50, projectId?: string): AgentActivityEvent[] {
  if (projectId) {
    return activityHistory.filter((e) => !e.projectId || e.projectId === projectId).slice(0, limit)
  }
  return activityHistory.slice(0, limit)
}

export function getLastAgentSearch(projectId?: string): AgentActivityEvent | null {
  if (projectId && lastSearchByProject.has(projectId)) {
    return lastSearchByProject.get(projectId) || null
  }
  return globalLastSearchEvent
}
