import type { BuscarChunk, BuscarResponse } from './types'
import { clamp01 } from './utils'

export type GraphNode =
  | {
      id: string
      kind: 'index'
      label: string
      relevance: number
      chunks: number
      type: 'INDEX'
      data?: {
        tipo: 'indice'
      }
    }
  | {
      id: string
      kind: 'search'
      label: string
      relevance: number
      chunks: number
      type: 'SEARCH'
      data: {
        query: string
        fecha: string
        total_archivos: number
        tipo: 'indice-busqueda'
        tags: ['grafo-semantico', 'indice']
        archivos_relevantes: Array<{
          basename: string
          relevancia: number
        }>
      }
    }
  | {
      id: string
      kind: 'folder'
      label: string
      path: string
      relevance: number
      chunks: number
      type: 'FOLDER'
    }
  | {
      id: string
      kind: 'file'
      label: string
      path: string
      relevance: number
      chunks: number
      type: 'FILE'
      data: {
        query: string
        archivo_original: string
        carpeta: string
        relevancia: number
        chunksCount: number
        fecha: string
        tags: ['grafo-semantico']
        fragmentos: Array<{
          numero: number
          linea_inicio: number | null
          linea_fin: number | null
          relevancia: number
          contenido: string
        }>
        archivos_relacionados: string[]
      }
    }
  | {
      id: string
      kind: 'chunk'
      label: string
      filePath: string
      relevance: number
      chunks: number
      chunkIndex: number
      type: 'CHUNK'
      chunkType?: string
      symbolName?: string
      scope?: string
      chunkData?: BuscarChunk
    }

export type GraphLink = {
  source: string
  target: string
  weight: number
  type:
    | 'index→search'
    | 'index→file'
    | 'search→file'
    | 'co-occurrence'
    | 'folder→folder'
    | 'folder→file'
    | 'file→chunk'
    | 'chunk→chunk'
    | 'chunk→file'
    | 'semantic-mesh'
  data?: Record<string, unknown>
}

export type GraphModel = {
  nodes: GraphNode[]
  links: GraphLink[]
}

function folderOf(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx === -1 ? '' : norm.slice(0, idx)
}

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx === -1 ? norm : norm.slice(idx + 1)
}

function normalizeRel01(raw: number): number {
  if (Number.isNaN(raw)) return 0
  const v = raw > 1 ? raw / 100 : raw
  return clamp01(v)
}

function aggregateByFile(query: string, chunks: BuscarChunk[]) {
  const grouped = new Map<string, BuscarChunk[]>()
  for (const c of chunks) {
    const prev = grouped.get(c.archivo)
    if (!prev) grouped.set(c.archivo, [c])
    else prev.push(c)
  }

  const filePaths = [...grouped.keys()]
  const basenames = filePaths.map((p) => baseName(p))

  const nowIso = new Date().toISOString()

  const files = filePaths
    .map((path) => {
      const list = grouped.get(path) || []
      const folder = folderOf(path)
      const relevanceMax01 = list.reduce((m, c) => Math.max(m, normalizeRel01(c.relevancia)), 0)
      const relevanceMaxRaw = list.reduce((m, c) => Math.max(m, c.relevancia), 0)
      const fragmentos = list.map((c, idx) => ({
        numero: idx + 1,
        linea_inicio: c.linea_inicio ?? null,
        linea_fin: c.linea_fin ?? null,
        relevancia: c.relevancia,
        contenido: c.contenido,
      }))
      // FIX: archivos_relacionados usa basenames de los DEMÁS archivos del resultado,
      // igual que la sección "Archivos relacionados en esta búsqueda" de Obsidian.
      // Se compara contra el basename del archivo actual, no contra el path completo.
      const currentBasename = baseName(path)
      const related = basenames.filter((b) => b !== currentBasename)
      return {
        path,
        basename: currentBasename,
        folder,
        relevanceMax01,
        relevanceMaxRaw,
        chunksCount: list.length,
        fragmentos,
        related,
        fecha: nowIso,
        query,
      }
    })
    .sort((a, b) => b.relevanceMax01 - a.relevanceMax01)

  return { files, nowIso }
}

export type BuildGraphOptions = {
  groupByFolder: boolean
  showChunkNodes: boolean
  maxChunkNodes: number
}

export function buildGraphFromSearch(last: BuscarResponse | null, options: BuildGraphOptions): GraphModel {
  if (!last || !Array.isArray(last.chunks) || last.chunks.length === 0) return { nodes: [], links: [] }

  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const nodeIds = new Set<string>()
  const linkIds = new Set<string>()
  const indexNodeId = 'idx:index'

  const pushNode = (n: GraphNode) => {
    if (nodeIds.has(n.id)) return
    nodeIds.add(n.id)
    nodes.push(n)
  }

  const pushLinkDirected = (
    source: string,
    target: string,
    type: GraphLink['type'],
    weight: number,
    data?: GraphLink['data'],
  ) => {
    const k = `${source}->${target}|${type}`
    if (linkIds.has(k)) return
    linkIds.add(k)
    links.push({ source, target, weight, type, data })
  }

  const pushLinkUndirected = (
    a: string,
    b: string,
    type: GraphLink['type'],
    weight: number,
    data?: GraphLink['data'],
  ) => {
    const [lo, hi] = a < b ? [a, b] : [b, a]
    const k = `${lo}|${hi}|${type}`
    if (linkIds.has(k)) return
    linkIds.add(k)
    links.push({ source: lo!, target: hi!, weight, type, data })
  }

  const { files, nowIso } = aggregateByFile(last.query, last.chunks)

  void nowIso
  void options

  pushNode({
    id: indexNodeId,
    kind: 'index',
    type: 'INDEX',
    label: 'INDEX',
    relevance: 1,
    chunks: last.chunks.length,
    data: { tipo: 'indice' },
  })

  for (const f of files) {
    const fileId = `f:${f.path}`
    pushNode({
      id: fileId,
      kind: 'file',
      type: 'FILE',
      label: f.basename,
      path: f.path,
      relevance: f.relevanceMax01,
      chunks: f.chunksCount,
      data: {
        query: last.query,
        archivo_original: f.path,
        carpeta: f.folder,
        relevancia: f.relevanceMaxRaw,
        chunksCount: f.chunksCount,
        fecha: f.fecha,
        tags: ['grafo-semantico'],
        fragmentos: f.fragmentos,
        archivos_relacionados: f.related,
      },
    })
    pushLinkDirected(indexNodeId, fileId, 'index→file', 1)
  }

  // 1. Archivos interconectados TODOS CONTRA TODOS (Malla dimensional completa entre todos los archivos)
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const f1 = files[i]!
      const f2 = files[j]!
      const a = `f:${f1.path}`
      const b = `f:${f2.path}`
      const weight = Math.max(0.18, (f1.relevanceMax01 + f2.relevanceMax01) / 2)
      pushLinkUndirected(a, b, 'co-occurrence', weight)
    }
  }

  // 2. Chunks interconectados TODOS CONTRA TODOS (Malla Semántica Tridimensional Completa)
  if (options.showChunkNodes) {
    const limited = last.chunks.slice(0, Math.max(0, options.maxChunkNodes))

    for (let i = 0; i < limited.length; i++) {
      const c = limited[i]!
      const chunkId = `c:${i}:${c.archivo}`
      const rel01 = normalizeRel01(c.relevancia)
      const range =
        c.linea_inicio != null && c.linea_fin != null
          ? `L${c.linea_inicio}-L${c.linea_fin}`
          : c.linea_inicio != null
            ? `L${c.linea_inicio}`
            : ''
      const badge = c.tipo && c.tipo !== 'block' ? `${c.tipo}: ` : ''
      const name = c.nombre ? c.nombre : `Chunk ${i + 1}`
      const label = range ? `${badge}${name} (${range})` : `${badge}${name}`

      pushNode({
        id: chunkId,
        kind: 'chunk',
        type: 'CHUNK',
        label,
        filePath: c.archivo,
        relevance: rel01,
        chunks: 1,
        chunkIndex: i,
        chunkType: c.tipo,
        symbolName: c.nombre,
        scope: c.scope,
        chunkData: c,
      })
    }
  }

  // Interconexión rigurosa TODOS CONTRA TODOS (Grafo Completo Kn):
  // Cada nodo del grafo se conecta con todos los demás nodos sin excepción en 3D
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const n1 = nodes[i]!
      const n2 = nodes[j]!
      let linkType: GraphLink['type'] = 'semantic-mesh'

      if (n1.kind === 'index' || n2.kind === 'index') {
        linkType = n1.kind === 'file' || n2.kind === 'file' ? 'index→file' : 'semantic-mesh'
      } else if (n1.kind === 'file' && n2.kind === 'file') {
        linkType = 'co-occurrence'
      } else if (n1.kind === 'chunk' && n2.kind === 'chunk') {
        const c1Path = (n1 as any).filePath
        const c2Path = (n2 as any).filePath
        linkType = c1Path && c2Path && c1Path === c2Path ? 'chunk→chunk' : 'semantic-mesh'
      } else if ((n1.kind === 'file' && n2.kind === 'chunk') || (n1.kind === 'chunk' && n2.kind === 'file')) {
        const fileNode = n1.kind === 'file' ? n1 : n2
        const chunkNode = n1.kind === 'chunk' ? n1 : n2
        linkType = (fileNode as any).path === (chunkNode as any).filePath ? 'file→chunk' : 'chunk→file'
      }

      const rel1 = n1.relevance || 0.5
      const rel2 = n2.relevance || 0.5
      const weight = Math.max(0.15, (rel1 + rel2) / 2)
      pushLinkUndirected(n1.id, n2.id, linkType, weight)
    }
  }

  return { nodes, links }
}
