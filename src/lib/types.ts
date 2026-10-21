export type HealthResponse = {
  status: 'ok'
}

export type StatsResponse = {
  status: 'ok'
  collection: string
  total_chunks: number
  unique_files: number | null
  embedding_provider: string
  embedding_dim: number | null
  project_dir: string
  index_extensions: string | null
  index_ignore_dirs: string | null
  search_top_k_default: number
}

export type ReindexProgress = {
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

export type ReindexJob = {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  created_at: number
  started_at: number | null
  finished_at: number | null
  exit_code: number | null
  error: string | null
  log_tail: string
  progress: ReindexProgress | null
}

export type ReindexStatusResponse =
  | { status: 'ok'; job: ReindexJob }
  | { status: 'no_job' }

export type ReindexStartResponse =
  | { status: 'needs_confirmation'; message: string }
  | { status: 'already_running'; job: ReindexJob }
  | { status: 'started'; job_id: string }

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

export type ProjectsResponse = {
  ok: boolean
  projects: ProjectRecord[]
  activeProject: ProjectRecord | null
}

export type BuscarRequest = {
  query: string
  top_k?: number | null
  usar_rag?: boolean
  project?: string
  project_path?: string
}

export type BuscarChunk = {
  archivo: string
  linea_inicio: number | null
  linea_fin: number | null
  relevancia: number
  contenido: string
  codigo_puro?: string
  tipo?: 'function' | 'method' | 'class' | 'component' | 'hook' | 'interface' | 'type' | 'section' | 'module' | 'block' | string
  nombre?: string
  scope?: string
  firma?: string
}

export type BuscarResponse = {
  query: string
  chunks: BuscarChunk[]
  respuesta: string | null
  project?: ProjectRecord
  warning?: string
}
