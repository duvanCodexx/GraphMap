import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'
import SpriteText from 'three-spritetext'
import { Api, ApiError } from './lib/api'
import { buildGraphFromSearch } from './lib/graph'
import { useInterval } from './lib/hooks'
import { copyToClipboard, ellipsisMiddle } from './lib/utils'

const DEFAULT_BASE_URL = (import.meta.env && import.meta.env.VITE_BACKEND_URL) || 'http://127.0.0.1:8001'

function safePercent01(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  const norm = v > 1 ? v / 100 : v
  return Math.max(0, Math.min(1, norm))
}

function formatMatch(relevance01) {
  const p = safePercent01(relevance01) * 100
  return `${p.toFixed(1)}%`
}

function getChunkTypeStyle(tipo) {
  const t = (tipo || 'block').toLowerCase()
  switch (t) {
    case 'component':
      return { label: 'COMP', color: '#06b6d4', glow: 'rgba(6, 182, 212, 0.55)', bg: 'bg-cyan-950/80 text-cyan-300 border-cyan-500/50' }
    case 'hook':
      return { label: 'HOOK', color: '#14b8a6', glow: 'rgba(20, 184, 166, 0.55)', bg: 'bg-teal-950/80 text-teal-300 border-teal-500/50' }
    case 'function':
      return { label: 'FUNC', color: '#10b981', glow: 'rgba(16, 185, 129, 0.55)', bg: 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50' }
    case 'class':
      return { label: 'CLASS', color: '#f59e0b', glow: 'rgba(245, 158, 11, 0.55)', bg: 'bg-amber-950/80 text-amber-300 border-amber-500/50' }
    case 'method':
      return { label: 'METHOD', color: '#3b82f6', glow: 'rgba(59, 130, 246, 0.55)', bg: 'bg-blue-950/80 text-blue-300 border-blue-500/50' }
    case 'interface':
    case 'type':
      return { label: 'TYPE', color: '#8b5cf6', glow: 'rgba(139, 92, 246, 0.55)', bg: 'bg-purple-950/80 text-purple-300 border-purple-500/50' }
    case 'section':
    case 'doc':
      return { label: 'DOC', color: '#f97316', glow: 'rgba(249, 115, 22, 0.55)', bg: 'bg-orange-950/80 text-orange-300 border-orange-500/50' }
    default:
      return { label: 'BLOCK', color: '#94a3b8', glow: 'rgba(148, 163, 184, 0.35)', bg: 'bg-slate-800/80 text-slate-300 border-slate-600/50' }
  }
}

// Hash determinista para generar desfase y desincronización orgánica entre aristas
function getLinkSeed(link) {
  if (!link) return 0
  const s = String(link.source?.id || link.source || '')
  const t = String(link.target?.id || link.target || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0
  return Math.abs(h)
}

// SINGLETONS Three.js: Geometrías compartidas a nivel de GPU para alto rendimiento y estética holográfica
const SHARED_SPHERE_GEOM = new THREE.SphereGeometry(1, 16, 12)
const SHARED_GLOW_GEOM = new THREE.SphereGeometry(1, 12, 10)
const SHARED_RING_GEOM = new THREE.RingGeometry(1.25, 1.45, 24)
SHARED_RING_GEOM.rotateX(Math.PI / 2) // pre-rotado para no recalcular rotación en cada frame

const THREE_MATERIAL_CACHE = new Map()

function getCachedThreeMaterial(type, colorHex, isSelected, isAgent) {
  const key = `${type}_${colorHex}_${isSelected ? 1 : 0}_${isAgent ? 1 : 0}`
  let mat = THREE_MATERIAL_CACHE.get(key)
  if (!mat) {
    if (type === 'core') {
      mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(colorHex),
        emissive: new THREE.Color(colorHex),
        emissiveIntensity: isSelected ? 0.9 : (isAgent ? 0.7 : 0.35),
      })
    } else if (type === 'glow') {
      mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorHex),
        transparent: true,
        opacity: isSelected ? 0.35 : 0.15,
        side: THREE.BackSide,
      })
    } else if (type === 'ring') {
      mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(isSelected ? '#ffffff' : '#38bdf8'),
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.65,
      })
    }
    THREE_MATERIAL_CACHE.set(key, mat)
  }
  return mat
}

function useElementSize() {
  const ref = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr) return
      setSize({ w: Math.floor(cr.width), h: Math.floor(cr.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return { ref, size }
}

export const CANDIDATE_PORTS = [8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010]

export default function EmbedingDashboard() {
  const [baseUrl, setBaseUrl] = useState(() => {
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      try {
        const p = new URLSearchParams(window.location.search).get('backendUrl')
        if (p && p.startsWith('http')) return p
      } catch {}
    }
    return DEFAULT_BASE_URL
  })
  const [healthOk, setHealthOk] = useState(null)

  // Multi-Project State
  const [projects, setProjects] = useState([])
  const [activeProjectId, setActiveProjectId] = useState(null)
  const [projectStats, setProjectStats] = useState(null)
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [newProjectPathInput, setNewProjectPathInput] = useState('')

  // Graphs Per Project Map: { [projectId]: { search: BuscarResponse, graphData: { nodes, links }, lastQuery: string } }
  const [graphsByProject, setGraphsByProject] = useState({})

  // Active Search & Inspect
  const [queryInput, setQueryInput] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [selectedNode, setSelectedNode] = useState(null)
  const [hoveredNode, setHoveredNode] = useState(null)
  const [codeCopied, setCodeCopied] = useState(false)
  const [showCodeDetails, setShowCodeDetails] = useState(false)

  // Reindex State
  const [reindexJob, setReindexJob] = useState(null)
  const [reindexBusy, setReindexBusy] = useState(false)

  // Agent & MCP Live State
  const [recentAgentProjects, setRecentAgentProjects] = useState({})
  const [agentTicker, setAgentTicker] = useState(null)
  const [agentInteraction, setAgentInteraction] = useState(null)
  const [agentMemoryStats, setAgentMemoryStats] = useState({ total_memories: 0, total_tokens_saved: 0 })
  const [agentMemories, setAgentMemories] = useState([])
  const [showMemoriesModal, setShowMemoriesModal] = useState(false)

  // MCP Agent Prompt State
  const [showMcpModal, setShowMcpModal] = useState(false)
  const [mcpInfo, setMcpInfo] = useState({ mcpServerPath: '', backendUrl: 'http://127.0.0.1:8001' })
  const [mcpCopyStatus, setMcpCopyStatus] = useState(null)
  const [activeMcpTab, setActiveMcpTab] = useState('prompt')

  // Settings State (Modo Local vs API, dimensiones MRL, claves)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [settingsValues, setSettingsValues] = useState({
    EMBEDDING_PROVIDER: 'gemma-local',
    GEMMA_LOCAL_DIMENSION: '512',
    GEMMA_API_URL: 'http://localhost:8000/v1',
    GEMMA_MODEL_NAME: 'google/embeddinggemma-270m',
    GEMMA_BATCH_SIZE: '32',
    VOYAGE_EMBEDDING_MODEL: 'voyage-code-3',
  })
  const [settingsSecrets, setSettingsSecrets] = useState({
    GEMMA_API_KEY: '',
    VOYAGE_API_KEY: '',
    GROQ_API_KEY: '',
  })
  const [hasSecrets, setHasSecrets] = useState({
    GEMMA_API_KEY: false,
    VOYAGE_API_KEY: false,
    GROQ_API_KEY: false,
  })
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaveMsg, setSettingsSaveMsg] = useState(null)
  const [testEmbedStatus, setTestEmbedStatus] = useState(null)
  const [localModelStatus, setLocalModelStatus] = useState(null)
  const [isDownloadingModel, setIsDownloadingModel] = useState(false)
  const [downloadModelProgress, setDownloadModelProgress] = useState(null)
  const [showVoyageKey, setShowVoyageKey] = useState(false)
  const [showGemmaKey, setShowGemmaKey] = useState(false)
  const [runInBackground, setRunInBackground] = useState(true)
  const [openAtLogin, setOpenAtLogin] = useState(false)

  // Native Window Management (Windows Snap / 1/4 Screen / Always On Top)
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [isNativeQuarter, setIsNativeQuarter] = useState(false)
  const [isCardCollapsed, setIsCardCollapsed] = useState(false)
  const [isHeaderHidden, setIsHeaderHidden] = useState(false)

  // Selector de instancias y efectos de transición artística
  const [isInstanceMenuOpen, setIsInstanceMenuOpen] = useState(false)
  const [transitionFx, setTransitionFx] = useState(null)
  const instanceMenuRef = useRef(null)

  const fgRef = useRef(null)
  const { ref: graphHostRef, size: graphHostSize } = useElementSize()

  // Detección reactiva de modo compacto (Pantalla dividida, Snap Assist o 1/4 PC)
  const isCompact = useMemo(() => {
    return isNativeQuarter || (graphHostSize.w > 0 && (graphHostSize.w < 860 || graphHostSize.h < 580))
  }, [isNativeQuarter, graphHostSize.w, graphHostSize.h])

  // Cerrar menú de instancias al hacer clic fuera
  useEffect(() => {
    if (!isInstanceMenuOpen) return
    const handleClickOutside = (e) => {
      if (instanceMenuRef.current && !instanceMenuRef.current.contains(e.target)) {
        setIsInstanceMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', handleClickOutside)
    return () => document.removeEventListener('pointerdown', handleClickOutside)
  }, [isInstanceMenuOpen])

  // Sincronizar estado nativo de 1/4 de pantalla desde Electron
  useEffect(() => {
    const electronApi = window.embeding
    if (!electronApi) return

    if (typeof electronApi.isQuarterScreen === 'function') {
      electronApi
        .isQuarterScreen()
        .then((res) => {
          if (res && typeof res.isQuarter === 'boolean') {
            setIsNativeQuarter(res.isQuarter)
          }
        })
        .catch(() => {})
    }

    if (typeof electronApi.onQuarterChanged === 'function') {
      const unsub = electronApi.onQuarterChanged((data) => {
        if (data && typeof data.isQuarter === 'boolean') {
          setIsNativeQuarter(data.isQuarter)
        }
      })
      return () => {
        if (typeof unsub === 'function') unsub()
      }
    }
  }, [])

  // Auto-resolución de puerto activo (8001-8010) y puente IPC de Electron
  useEffect(() => {
    let active = true

    async function detectActiveBackend() {
      // 1. Preguntar a Electron IPC (máxima prioridad y exactitud)
      if (window.embeding && typeof window.embeding.getBackendUrl === 'function') {
        try {
          const res = await window.embeding.getBackendUrl()
          if (res && res.url && active) {
            setBaseUrl(res.url)
            return
          }
        } catch {}
      }

      // 2. Parámetro query en la URL de la ventana
      if (typeof window !== 'undefined' && window.location && window.location.search) {
        try {
          const param = new URLSearchParams(window.location.search).get('backendUrl')
          if (param && param.startsWith('http') && active) {
            setBaseUrl(param)
            return
          }
        } catch {}
      }

      // 3. Sondeo activo secuencial en puertos candidatos 8001..8010
      for (const port of CANDIDATE_PORTS) {
        if (!active) return
        const testUrl = `http://127.0.0.1:${port}`
        try {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 500)
          const res = await fetch(`${testUrl}/health`, { signal: ctrl.signal })
          clearTimeout(timer)
          if (res.ok && active) {
            setBaseUrl(testUrl)
            return
          }
        } catch {}
      }
    }

    detectActiveBackend()
    return () => {
      active = false
    }
  }, [])

  const activeProject = useMemo(() => {
    if (!projects.length) return null
    return projects.find((p) => p.id === activeProjectId) || projects[0]
  }, [projects, activeProjectId])

  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => {
    activeProjectIdRef.current = activeProjectId
  }, [activeProjectId])

  const projectsRef = useRef(projects)
  useEffect(() => {
    projectsRef.current = projects
  }, [projects])

  const handleSelectProjectRef = useRef(null)
  const refreshStatsRef = useRef(null)
  const updateProjectGraphRef = useRef(null)
  const graphsByProjectRef = useRef(graphsByProject)
  useEffect(() => {
    graphsByProjectRef.current = graphsByProject
  }, [graphsByProject])
  const isCompactRef = useRef(isCompact)
  useEffect(() => {
    isCompactRef.current = isCompact
  }, [isCompact])

  // Cargar proyectos desde el backend
  const loadProjects = useCallback(async (forcedActiveId = null) => {
    try {
      const res = await Api.getProjects(baseUrl)
      if (res && res.ok && Array.isArray(res.projects)) {
        setProjects((prev) => {
          if (
            prev.length === res.projects.length &&
            prev.every((p, i) => p.id === res.projects[i].id && p.totalChunks === res.projects[i].totalChunks && p.name === res.projects[i].name)
          ) {
            return prev
          }
          return res.projects
        })
        if (forcedActiveId) {
          setActiveProjectId(forcedActiveId)
        } else if (!activeProjectIdRef.current && res.activeProject) {
          setActiveProjectId(res.activeProject.id)
        } else if (!activeProjectIdRef.current && res.projects.length > 0) {
          setActiveProjectId(res.projects[0].id)
        }
        return res
      }
    } catch (e) {
      console.warn('Error cargando proyectos:', e)
    }
    return null
  }, [baseUrl])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  // Sincronización periódica de proyectos cada 8 segundos (fallback para MCP y agentes externos)
  useInterval(() => {
    loadProjects()
  }, 8000)

  // Chequeo de salud del backend
  useInterval(() => {
    Api.health(baseUrl)
      .then(() => setHealthOk(true))
      .catch(() => setHealthOk(false))
  }, 3000)

  // Cargar estadísticas del proyecto activo
  const refreshStats = useCallback(async () => {
    if (!activeProject) return
    try {
      const [s, m] = await Promise.all([
        Api.stats(baseUrl, activeProject.id).catch(() => null),
        Api.agentMemories(baseUrl, activeProject.id).catch(() => null),
      ])
      if (s) setProjectStats(s)
      if (m && m.ok) {
        setAgentMemories(m.memories || [])
        setAgentMemoryStats(m.stats || { total_memories: 0, total_tokens_saved: 0 })
      }
    } catch {}
  }, [baseUrl, activeProject])

  useEffect(() => {
    refreshStats()
  }, [refreshStats])

  useInterval(refreshStats, 6000)

  useEffect(() => {
    refreshStatsRef.current = refreshStats
  }, [refreshStats])

  // Cargar ruta del servidor MCP e información del backend para agentes de código
  useEffect(() => {
    const fetchMcpInfo = async () => {
      try {
        if (window.embeding?.getMcpInfo) {
          const info = await window.embeding.getMcpInfo()
          if (info && info.mcpServerPath) {
            setMcpInfo({ ...info, backendUrl: baseUrl || info.backendUrl })
            return
          }
        }
        const res = await fetch(`${baseUrl}/mcp/info`).then((r) => r.json()).catch(() => null)
        if (res && res.mcpServerPath) {
          setMcpInfo({ ...res, backendUrl: baseUrl || res.backendUrl })
        }
      } catch {}
    }
    fetchMcpInfo()
  }, [baseUrl])

  // Cargar configuración de embeddings
  const loadSettings = useCallback(async () => {
    try {
      if (window.embeding?.getSettings) {
        const s = await window.embeding.getSettings()
        if (s?.values) setSettingsValues((prev) => ({ ...prev, ...s.values }))
        if (s?.hasSecrets) setHasSecrets(s.hasSecrets)
      } else {
        const s = await fetch(`${baseUrl}/settings`).then((r) => r.json()).catch(() => null)
        if (s?.values) setSettingsValues((prev) => ({ ...prev, ...s.values }))
        if (s?.hasSecrets) setHasSecrets(s.hasSecrets)
      }

      if (window.embeding?.getSystemSettings) {
        const sys = await window.embeding.getSystemSettings()
        if (sys) {
          setRunInBackground(Boolean(sys.runInBackground))
          setOpenAtLogin(Boolean(sys.openAtLogin))
        }
      }
    } catch {}
    fetchModelStatus()
  }, [baseUrl])

  const handleToggleRunInBackground = async () => {
    const next = !runInBackground
    setRunInBackground(next)
    if (window.embeding?.setRunInBackground) {
      await window.embeding.setRunInBackground(next)
    }
  }

  const handleToggleOpenAtLogin = async () => {
    const next = !openAtLogin
    setOpenAtLogin(next)
    if (window.embeding?.setOpenAtLogin) {
      await window.embeding.setOpenAtLogin(next)
    }
  }

  const handleHideToTray = async () => {
    if (window.embeding?.hideToTray) {
      await window.embeding.hideToTray()
    }
  }

  const fetchModelStatus = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/model/status`).then((r) => r.json()).catch(() => null)
      if (res && res.ok) {
        setLocalModelStatus(res)
        if (res.downloading) {
          setIsDownloadingModel(true)
          if (res.progress) setDownloadModelProgress(res.progress)
        } else if (res.installed) {
          setIsDownloadingModel(false)
        }
      }
    } catch {}
  }, [baseUrl])

  // Polling activo del progreso de descarga de modelo local
  useEffect(() => {
    if (!isDownloadingModel) return

    let isMounted = true
    const pollProgress = async () => {
      try {
        const res = await fetch(`${baseUrl}/model/status`).then((r) => r.json()).catch(() => null)
        if (!isMounted || !res || !res.ok) return

        if (res.progress) {
          setDownloadModelProgress(res.progress)
        }
        if (res.installed || res.progress?.status === 'ready') {
          setIsDownloadingModel(false)
          setLocalModelStatus((prev) => ({ ...prev, installed: true, downloading: false }))
        } else if (res.progress?.status === 'error') {
          setIsDownloadingModel(false)
        }
      } catch {}
    }

    pollProgress()
    const interval = setInterval(pollProgress, 800)
    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [isDownloadingModel, baseUrl])

  const handleStartModelDownload = async () => {
    setIsDownloadingModel(true)
    setDownloadModelProgress({ progress: 1, message: 'Conectando con Hugging Face (IPv4)...' })
    try {
      const res = await fetch(`${baseUrl}/model/download`, { method: 'POST' }).then((r) => r.json())
      if (res?.status === 'ready') {
        setIsDownloadingModel(false)
        setLocalModelStatus((prev) => ({ ...prev, installed: true, downloading: false }))
      } else if (res?.status === 'downloading') {
        if (res.progress) setDownloadModelProgress(res.progress)
      }
    } catch (e) {
      setIsDownloadingModel(false)
      setDownloadModelProgress({ progress: 0, message: `Error al iniciar descarga: ${e.message}` })
    }
  }

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  useEffect(() => {
    if (showSettingsModal) {
      fetchModelStatus()
    }
  }, [showSettingsModal, fetchModelStatus])

  const handleSaveSettings = async () => {
    setSettingsSaving(true)
    setSettingsSaveMsg(null)
    try {
      const secretsToSave = {}
      if (settingsSecrets.GEMMA_API_KEY.trim()) secretsToSave.GEMMA_API_KEY = settingsSecrets.GEMMA_API_KEY.trim()
      if (settingsSecrets.VOYAGE_API_KEY.trim()) secretsToSave.VOYAGE_API_KEY = settingsSecrets.VOYAGE_API_KEY.trim()
      if (settingsSecrets.GROQ_API_KEY.trim()) secretsToSave.GROQ_API_KEY = settingsSecrets.GROQ_API_KEY.trim()

      let res
      if (window.embeding?.saveSettings) {
        res = await window.embeding.saveSettings({
          values: settingsValues,
          secrets: secretsToSave,
        })
      } else {
        const fetchRes = await fetch(`${baseUrl}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: settingsValues, secrets: secretsToSave }),
        })
        res = await fetchRes.json().catch(() => null)
      }

      if (res?.values) setSettingsValues((prev) => ({ ...prev, ...res.values }))
      if (res?.hasSecrets) setHasSecrets(res.hasSecrets)
      setSettingsSecrets({ GEMMA_API_KEY: '', VOYAGE_API_KEY: '', GROQ_API_KEY: '' })
      setSettingsSaveMsg('¡Configuración guardada correctamente!')
      setTimeout(() => setSettingsSaveMsg(null), 3000)
      refreshStats()
    } catch (e) {
      setSettingsSaveMsg(`Error al guardar: ${e.message}`)
    } finally {
      setSettingsSaving(false)
    }
  }

  const handleTestEmbedding = async () => {
    // Si hay cambios no guardados en los inputs de secretos, guardarlos primero
    if (
      settingsSecrets.VOYAGE_API_KEY.trim() ||
      settingsSecrets.GEMMA_API_KEY.trim() ||
      settingsSecrets.GROQ_API_KEY.trim()
    ) {
      await handleSaveSettings()
    }

    if (settingsValues.EMBEDDING_PROVIDER === 'gemma-local' && localModelStatus && !localModelStatus.installed) {
      setTestEmbedStatus({
        ok: false,
        error: 'El modelo local no está descargado todavía. Haz clic en "Descargar Modelo Local" antes de probar.',
      })
      return
    }
    setTestEmbedStatus('testing')
    try {
      const rawRes = await fetch(`${baseUrl}/model/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const res = await rawRes.json().catch(() => ({ error: `HTTP ${rawRes.status}` }))
      if (!res.ok) {
        setTestEmbedStatus({ ok: false, error: res.error || 'Error al conectar con el proveedor de embeddings' })
      } else {
        setTestEmbedStatus({
          ok: true,
          timeMs: res.timeMs,
          dimension: res.dimension,
          provider: res.provider || settingsValues.EMBEDDING_PROVIDER || 'gemma-local',
        })
      }
    } catch (e) {
      setTestEmbedStatus({ ok: false, error: e.message })
    }
  }

  const handleCopyText = useCallback((text, type) => {
    if (!text) return
    navigator.clipboard.writeText(text)
    setMcpCopyStatus(type)
    setTimeout(() => {
      setMcpCopyStatus(null)
    }, 2500)
  }, [])

  const currentMcpServerPath = useMemo(() => {
    return (mcpInfo.mcpServerPath || 'C:/Users/duvan/Documents/EMBEDING-ELECTRON/mcp-server.cjs').replace(/\\/g, '/')
  }, [mcpInfo.mcpServerPath])

  const fullAgentPrompt = useMemo(() => {
    const serverUrl = mcpInfo.backendUrl || baseUrl || 'http://127.0.0.1:8001'

    return `Actúa como desarrollador senior en este repositorio. Tu objetivo es integrar y verificar el servidor MCP "embeding" para el proyecto donde estás ubicado, ejecutar las pruebas de validación de consumo de tokens y aplicar las directivas en tu flujo de trabajo:

[INSTRUCCIÓN CLAVE PARA EL AGENTE]:
- NO asumas rutas quemadas ni nombres fijos de proyectos externos.
- Detecta y registra la ruta absoluta del espacio de trabajo donde te encuentras parado actualmente (Working Directory / Workspace) como "project_path" (ejemplo: "C:/ruta/a/tu/proyecto" o "/home/usuario/proyecto") y utiliza el nombre de la carpeta raíz como nombre del proyecto a registrar.

======================================================================
1. INSTALACIÓN Y CONFIGURACIÓN INICIAL DEL MCP
======================================================================
Registra el servidor MCP en tu entorno (.cursor/mcp.json, claude_desktop_config.json, Cline o CLI) configurando tu proyecto actual:
- Comando: node
- Argumentos: ["${currentMcpServerPath}"]
- Variables de entorno:
    EMBEDING_SERVER_URL: "${serverUrl}"
    EMBEDING_PROJECT_PATH: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" (Ejemplo: "C:/ruta/a/tu/proyecto")

Verifica la conectividad llamando a la herramienta MCP usando la ruta donde estás ubicado:
- get_stats({ project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" })

Si el proyecto no tiene fragmentos vectorizados o es nuevo, inicia la indexación completa en segundo plano:
- reindex_project({ confirmar: true, project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" })

======================================================================
2. PROTOCOLO DE TEST: VALIDACIÓN DE CONSUMO DE TOKENS (CON Y SIN MCP)
======================================================================
Para auditar empíricamente la eficiencia de la búsqueda vectorial semántica y contrastar el consumo de tokens, realiza la siguiente prueba controlada en este proyecto:

[FASE A - BÚSQUEDA SEMÁNTICA CON MCP]:
1. Formula una consulta conceptual relevante para la arquitectura de este proyecto (ej: "autenticación y tokens", "flujo de reindexación", o el módulo principal de este repositorio).
2. Ejecuta la herramienta MCP pasando la ruta de tu proyecto actual:
   search_code({ query: "<tu consulta>", top_k: 3, project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" })
3. Observa la respuesta: El MCP extrae únicamente los chunks funcionales específicos (métodos, clases y rangos exactos de líneas L10-L45) con su score de similitud.
4. Anota los tokens consumidos en el contexto: Típicamente entre 300 y 900 tokens en total.

[FASE B - BÚSQUEDA / LECTURA CONVENCIONAL SIN MCP]:
1. Identifica los archivos completos donde residen esas funciones o módulos consultados.
2. Simula el procedimiento clásico de un asistente sin MCP leyendo los archivos enteros (con herramientas como read_file o inspecciones completas de código).
3. Calcula o anota el volumen de tokens inyectados en la ventana de contexto: Habitualmente entre 8,000 y 45,000+ tokens por archivo.

[FASE C - INFORME Y TABLA COMPARATIVA]:
Genera en tu respuesta un reporte de auditoría con la siguiente estructura:
----------------------------------------------------------------------
| Métrica Evaluada                | Sin MCP (Lectura Completa) | Con MCP (Embeding Vectorial) | Eficiencia / Ahorro |
| Contexto Inyectado              | ~XX,XXX tokens             | ~XXX tokens                  | > 85% - 95% ahorro  |
| Precisión de Localización       | Archivo completo disperso  | Líneas exactas y función     | Quirúrgico          |
| Saturación de la Ventana (CTX)  | Elevada (degrada atención) | Mínima (máxima retención)    | Óptima              |
| Latencia de Inferencia          | Lenta (procesa megabytes)  | Instantánea                  | Alta Velocidad       |
----------------------------------------------------------------------

[FASE D - REGISTRO EN MEMORIA DEL PROYECTO]:
Guarda el resultado del benchmark en la memoria semántica persistente del MCP:
store_memory({
  key: "mcp_token_benchmark",
  content: "Benchmark de consumo de tokens: Búsqueda con search_code consumió ~XXX tokens frente a ~XX,XXX tokens sin MCP (>90% ahorro). Chunks precisos recuperados.",
  project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>"
})

======================================================================
3. REGLAS OBLIGATORIAS DE DESARROLLO CONTINUO
======================================================================
- BÚSQUEDA QUIRÚRGICA: NUNCA leas archivos completos a ciegas para responder preguntas de código. Utiliza SIEMPRE search_code({ query: "...", top_k: 5, project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" }).
- REINDEXACIÓN TRAS MODIFICAR: Cada vez que crees, modifiques o refactorices uno o más archivos, es OBLIGATORIO ejecutar al terminar:
  reindex_file({ file_path: "ruta/del/archivo.ext", project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" })
  Esto mantiene el índice vectorial y el visualizador 3D GraphMap sincronizados al segundo.
- MEMORIA ARQUITECTÓNICA: Utiliza store_memory y recall_memory para preservar decisiones técnicas entre sesiones sin gastar tokens releyendo el historial.`
  }, [currentMcpServerPath, mcpInfo.backendUrl, baseUrl])

  const agentRulesContent = useMemo(() => {
    return `# DIRECTIVAS DE EMBEDING, MCP Y EFICIENCIA DE TOKENS

## 1. BÚSQUEDA SEMÁNTICA OBLIGATORIA (MCP SEARCH)
- Para explorar el repositorio, entender arquitectura o localizar funciones, usa SIEMPRE la herramienta MCP:
  \`search_code({ query: "descripción funcional", top_k: 5, project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" })\`
  *(Reemplaza <RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL> con la ruta absoluta donde estás ubicado, ej: "C:/ruta/a/tu/proyecto")*
- PROHIBIDO leer archivos completos indiscriminadamente cuando una búsqueda semántica puede traer las 20-50 líneas exactas.

## 2. BENCHMARK Y AUDITORÍA DE TOKENS
- Al iniciar tareas de investigación complejas, audita el consumo de contexto:
  - Búsqueda MCP: ~300 a 800 tokens de contexto quirúrgico.
  - Lectura bruta sin MCP: 10,000 a 50,000+ tokens que saturan la ventana de contexto.
- Documenta hallazgos arquitectónicos y resultados del benchmark con:
  \`store_memory({ key: "arquitectura_modulo_x", content: "...", project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" })\`

## 3. REINDEXACIÓN TRAS CADA MODIFICACIÓN
- Cada vez que crees, modifiques o elimines código, ejecuta al finalizar:
  \`reindex_file({ file_path: "ruta/al/archivo.ext", project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" })\`
- Esto garantiza que el grafo semántico 3D y los vectores se mantengan 100% sincronizados en tiempo real.

## 4. GESTIÓN DE MEMORIA PERSISTENTE
- Antes de proponer refactorizaciones globales, consulta las decisiones previas registradas:
  \`recall_memory({ query: "tema o decisión", project_path: "<RUTA_ABSOLUTA_DE_TU_PROYECTO_ACTUAL>" })\`
`
  }, [])

  const mcpJsonConfig = useMemo(() => {
    return JSON.stringify(
      {
        mcpServers: {
          embeding: {
            command: 'node',
            args: [currentMcpServerPath],
            env: {
              EMBEDING_SERVER_URL: mcpInfo.backendUrl || baseUrl || 'http://127.0.0.1:8001',
            },
          },
        },
      },
      null,
      2,
    )
  }, [currentMcpServerPath, mcpInfo.backendUrl, baseUrl])

  const claudeCliCommand = useMemo(() => {
    return `claude mcp add embeding node "${currentMcpServerPath}"`
  }, [currentMcpServerPath])


  // Aplicar física fluida de D3 al estilo Obsidian Graph View con expansión 10% y respiración cósmica asíncrona
  const applyFluidPhysics = useCallback(() => {
    const fg = fgRef.current
    if (!fg) return
    try {
      // 1. Repel Force (Obsidian charge / repel con corte de distancia ampliado 10%)
      const charge = fg.d3Force('charge')
      if (charge) {
        if (typeof charge.strength === 'function') {
          charge.strength(isCompact ? -132 : -210) // 10% mayor repulsión (antes -120 : -190)
        }
        if (typeof charge.distanceMax === 'function') {
          charge.distanceMax(isCompact ? 385 : 550) // 10% mayor alcance (antes 350 : 500)
        }
        if (typeof charge.theta === 'function') {
          charge.theta(0.85) // Algoritmo Barnes-Hut rápido Obsidian
        }
      }

      // 2. Center Force (Obsidian center / gravedad suave hacia el origen)
      const center = fg.d3Force('center')
      if (center && typeof center.strength === 'function') {
        center.strength(isCompact ? 0.25 : 0.20) // Más suave para permitir la expansión del 10%
      }

      // 3. Link Force (Longitudes de reposo incrementadas exactamente un 10%)
      const link = fg.d3Force('link')
      if (link) {
        if (typeof link.distance === 'function') {
          link.distance((l) => {
            if (l.type === 'index→file') return isCompact ? 61 : 94    // +10% (antes 55 : 85)
            if (l.type === 'co-occurrence') return isCompact ? 44 : 72  // +10% (antes 40 : 65)
            if (l.type === 'file→chunk') return isCompact ? 28 : 42     // +10% (antes 25 : 38)
            if (l.type === 'chunk→chunk') return isCompact ? 20 : 31    // +10% (antes 18 : 28)
            if (l.type === 'semantic-mesh') return isCompact ? 33 : 50  // +10% (antes 30 : 45)
            return isCompact ? 31 : 46                                  // +10% (antes 28 : 42)
          })
        }
        if (typeof link.strength === 'function') {
          link.strength((l) => {
            if (l.type === 'file→chunk') return 0.72
            if (l.type === 'index→file') return 0.62
            if (l.type === 'chunk→chunk') return 0.48
            return 0.32 // co-occurrence y semantic-mesh
          })
        }
      }

      // 4. Fuerza de Respiración Orgánica Asíncrona (Alejamiento y Acercamiento Autónomo por Nodo)
      fg.d3Force('breathing', () => {
        try {
          const graphData = fg.graphData?.()
          const nodes = graphData?.nodes || activeProjectGraph?.nodes || []
          if (!nodes || nodes.length <= 1) return
          const t = performance.now() * 0.001

          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i]
            if (!n || n.kind === 'index') continue // El hub central permanece anclado como centro de gravedad estable

            // Asignar parámetros únicos y no coordinados a cada nodo si no los tiene
            if (n.__bFreq == null) {
              let h = 0
              const str = String(n.id || i)
              for (let j = 0; j < str.length; j++) h = (h * 31 + str.charCodeAt(j)) | 0
              // Frecuencia asíncrona única por nodo (ciclos no coordinados entre 4s y 8.5s)
              n.__bFreq = 0.75 + (Math.abs(h % 80) / 100) * 0.8
              // Desfase de fase completamente independiente
              n.__bPhase = (Math.abs((h >> 3) % 100) / 100) * Math.PI * 2
              // Amplitud propia (cada nodo toma una distancia única de alejamiento/acercamiento)
              n.__bAmp = isCompact
                ? 0.35 + (Math.abs((h >> 6) % 50) / 100) * 0.45
                : 0.55 + (Math.abs((h >> 6) % 60) / 100) * 0.65
            }

            const x = Number(n.x) || 0
            const y = Number(n.y) || 0
            const z = Number(n.z) || 0
            const len = Math.hypot(x, y, z) || 1

            // Oscilación senoidal asíncrona: aleja (+) y acerca (-) independientemente
            const wave = Math.sin(t * n.__bFreq + n.__bPhase)
            const radial = wave * n.__bAmp * 0.075

            n.vx = (Number(n.vx) || 0) + (x / len) * radial
            n.vy = (Number(n.vy) || 0) + (y / len) * radial
            n.vz = (Number(n.vz) || 0) + (z / len) * radial
          }
        } catch {}
      })

      // 5. Inercia Fluida y Target Alpha Constante para Mantener Viva la Respiración Cósmica
      if (typeof fg.d3VelocityDecay === 'function') fg.d3VelocityDecay(0.35)
      if (typeof fg.d3AlphaDecay === 'function') fg.d3AlphaDecay(0.018)
      if (typeof fg.d3AlphaTarget === 'function') fg.d3AlphaTarget(0.012) // Mantiene la animación viva perpetuamente
      if (typeof fg.d3ReheatSimulation === 'function') fg.d3ReheatSimulation()
    } catch {}
  }, [isCompact, activeProjectGraph?.nodes?.length])

  // Re-ajustar física y encuadre fluido cuando se entra o sale de la vista 1/4
  useEffect(() => {
    applyFluidPhysics()
    const timer = setTimeout(() => {
      try {
        fgRef.current?.zoomToFit(500, isCompact ? 30 : 60)
      } catch {}
    }, 150)
    return () => clearTimeout(timer)
  }, [isCompact, applyFluidPhysics])

  // Actualizar el modelo de grafo (Solo archivos y sus conexiones, con nacimientos orbitales orgánicos)
  const updateProjectGraph = useCallback((projId, searchResponse, queryStr) => {
    const model = buildGraphFromSearch(searchResponse, {
      groupByFolder: false,
      showChunkNodes: true,
      maxChunkNodes: 35,
    })

    setGraphsByProject((prev) => {
      const prevGraph = prev[projId]
      const prevNodesMap = new Map((prevGraph?.graphData?.nodes || []).map((n) => [n.id, n]))
      const indexNode = prevNodesMap.get('idx:index')
      const now = Date.now()

      // Preservar coordenadas existentes para transición suave sin saltos
      const nextNodes = model.nodes.map((n, idx) => {
        const existing = prevNodesMap.get(n.id)
        if (existing) {
          const { x, y, z, vx, vy, vz, fx, fy, fz } = existing
          Object.assign(existing, n)
          if (x != null) existing.x = x
          if (y != null) existing.y = y
          if (z != null) existing.z = z
          if (vx != null) existing.vx = vx
          if (vy != null) existing.vy = vy
          if (vz != null) existing.vz = vz
          if (fx != null) existing.fx = fx
          if (fy != null) existing.fy = fy
          if (fz != null) existing.fz = fz
          return existing
        }
        // Nodo nuevo: nace con timestamp y coordenadas en espiral áurea armónica 3D
        const created = { ...n, _birthTime: now }
        if (indexNode && indexNode.x != null && indexNode.y != null) {
          const angle = idx * 2.39996 // Golden ratio angle
          const dist = 10 + Math.sqrt(idx + 1) * 14
          const zAngle = idx * 1.618
          created.x = indexNode.x + Math.cos(angle) * dist
          created.y = indexNode.y + Math.sin(angle) * dist
          created.z = (indexNode.z || 0) + Math.sin(zAngle) * dist * 0.5
        } else {
          const angle = idx * 2.39996
          const dist = 8 + Math.sqrt(idx + 1) * 12
          const zAngle = idx * 1.618
          created.x = Math.cos(angle) * dist
          created.y = Math.sin(angle) * dist
          created.z = Math.sin(zAngle) * dist * 0.5
        }
        return created
      })

      const nextLinks = model.links.map((l) => ({
        source: l.source,
        target: l.target,
        value: l.weight,
        type: l.type,
      }))

      return {
        ...prev,
        [projId]: {
          search: searchResponse,
          graphData: { nodes: nextNodes, links: nextLinks },
          lastQuery: queryStr,
        },
      }
    })
  }, [])

  useEffect(() => {
    updateProjectGraphRef.current = updateProjectGraph
  }, [updateProjectGraph])

  // Ejecutar búsqueda manual en el proyecto activo con transición artística cinematográfica
  const handleRunSearch = useCallback(
    async (overrideQuery) => {
      const q = (overrideQuery ?? queryInput).trim()
      if (!q || !activeProject) return

      try {
        setIsSearching(true)

        // Fase 1: Desaceleración y retroceso cinematográfico de cámara 3D
        if (fgRef.current) {
          try {
            fgRef.current.cameraPosition(
              { x: 0, y: 0, z: isCompact ? 400 : 550 },
              { x: 0, y: 0, z: 0 },
              380
            )
          } catch {}
        }

        const resp = await Api.buscar(baseUrl, {
          query: q,
          top_k: 15,
          usar_rag: false,
          project: activeProject.id,
        })

        // Retardo artístico intencional para cadencia de pulso cuántico
        await new Promise((r) => setTimeout(r, 220))

        // Fase 2: Desatar onda expansiva cuántica y actualizar modelo con floración orbital
        setTransitionFx({ startedAt: Date.now(), duration: 1900, type: 'search' })
        updateProjectGraph(activeProject.id, resp, q)

        if (fgRef.current) {
          applyFluidPhysics()
          try {
            fgRef.current.d3VelocityDecay?.(0.35)
            fgRef.current.d3Alpha?.(0.65)
            fgRef.current.d3AlphaDecay?.(0.018)
            fgRef.current.d3AlphaTarget?.(0.012)
            fgRef.current.d3ReheatSimulation?.()
          } catch {}

          // Fase 3: Encuadre panorámico suave y cinematográfico que deja asentar los nodos
          setTimeout(() => {
            try {
              fgRef.current?.zoomToFit(1200, isCompact ? 40 : 70)
            } catch {}
          }, 450)
        }
      } catch (e) {
        console.error(e)
      } finally {
        setIsSearching(false)
      }
    },
    [queryInput, activeProject, baseUrl, updateProjectGraph, isCompact],
  )

  // Real-Time SSE Subscription for MCP Agent actions across all projects
  useEffect(() => {
    let es = null
    let reconnectTimer = null

    const connectSse = () => {
      try {
        es = new EventSource(`${baseUrl}/agent/events`)
        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (!data || !data.action) return

            // Sincronización en tiempo real de proyectos desde MCP u orígenes externos
            if (data.action === 'projects_changed' || data.action === 'reindex_completed') {
              if (Array.isArray(data.projects)) {
                setProjects(data.projects)
              } else {
                loadProjects()
              }
              const newActiveId = data.activeProjectId || data.projectId
              if (newActiveId && newActiveId !== activeProjectIdRef.current) {
                if (typeof handleSelectProjectRef.current === 'function') {
                  handleSelectProjectRef.current(newActiveId)
                }
              } else if (newActiveId) {
                if (typeof refreshStatsRef.current === 'function') {
                  refreshStatsRef.current()
                }
                // Si el proyecto activo acaba de indexarse o no tiene nodos, cargarlos de inmediato en el grafo 3D
                try {
                  Api.buscar(baseUrl, { query: '', top_k: 15, usar_rag: false, project: newActiveId })
                    .then((res) => {
                      if (res && res.chunks && res.chunks.length > 0 && typeof updateProjectGraphRef.current === 'function') {
                        updateProjectGraphRef.current(newActiveId, res, '')
                      }
                    })
                    .catch(() => {})
                } catch {}
              }
              return
            }

            if (data.action === 'model_progress') {
              setDownloadModelProgress(data)
              if (data.status === 'ready') {
                setIsDownloadingModel(false)
                setLocalModelStatus((prev) => ({ ...prev, installed: true, downloading: false }))
              } else if (data.status === 'error') {
                setIsDownloadingModel(false)
              } else if (data.status === 'downloading') {
                setIsDownloadingModel(true)
              }
              return
            }

            const targetProjId = data.projectId || activeProjectIdRef.current
            const projName = data.projectName || (projectsRef.current.find((p) => p.id === targetProjId)?.name) || 'Proyecto'

            // Identificar los nodos manipulados por el agente
            const manipulatedNodeIds = new Set()
            let primaryNodeId = null

            if (data.action === 'search' && Array.isArray(data.chunks)) {
              data.chunks.forEach((c, idx) => {
                const fileId = `f:${c.archivo}`
                const chunkId = `c:${idx}:${c.archivo}`
                manipulatedNodeIds.add(fileId)
                manipulatedNodeIds.add(chunkId)
                if (!primaryNodeId) primaryNodeId = chunkId
              })
            } else if (data.filePath) {
              const fileId = `f:${data.filePath}`
              manipulatedNodeIds.add(fileId)
              primaryNodeId = fileId
            }

            // Registrar interacción en vivo del agente
            setAgentInteraction({
              agentName: data.agentName || 'Agente IA',
              action: data.action,
              targetNodeIds: manipulatedNodeIds,
              primaryNodeId,
              query: data.query || data.key || data.filePath || '',
              details: data.details || '',
              projectName: projName,
              tokensSaved: data.tokensSaved,
              timestamp: Date.now(),
            })

            // Mostrar ticker flotante minimalista
            setAgentTicker({
              agentName: data.agentName || 'Agente IA',
              action: data.action,
              query: data.query || data.key || data.filePath || '',
              projectName: projName,
              details: data.details || '',
              tokensSaved: data.tokensSaved,
              timestamp: Date.now(),
            })

            // Marcar proyecto con actividad reciente de agente
            if (targetProjId) {
              setRecentAgentProjects((prev) => ({ ...prev, [targetProjId]: Date.now() }))
            }

            // Si es búsqueda, reflejar en el grafo del proyecto objetivo
            if (data.action === 'search' && Array.isArray(data.chunks)) {
              if (typeof updateProjectGraphRef.current === 'function') {
                updateProjectGraphRef.current(targetProjId, { query: data.query, chunks: data.chunks }, data.query)
              }

              // Si es el proyecto activo, centrar la cámara en el nodo manipulado por el agente
              if (targetProjId === activeProjectIdRef.current) {
                setQueryInput(data.query)
                if (fgRef.current) {
                  fgRef.current.d3ReheatSimulation()
                  setTimeout(() => {
                    try {
                      if (primaryNodeId) {
                        const currentNodes = graphsByProjectRef.current[targetProjId]?.graphData?.nodes || []
                        const target = currentNodes.find((n) => n.id === primaryNodeId)
                        if (target && target.x != null && target.y != null) {
                          const dist = isCompactRef.current ? 120 : 180
                          fgRef.current?.cameraPosition(
                            { x: target.x, y: target.y, z: (target.z || 0) + dist },
                            { x: target.x, y: target.y, z: target.z || 0 },
                            600
                          )
                          return
                        }
                      }
                      fgRef.current?.zoomToFit(700, 50)
                    } catch {}
                  }, 250)
                }
              }
            }

            // Si es memoria, refrescar estadísticas
            if (data.action === 'store_memory' || data.action === 'recall_memory') {
              if (typeof refreshStatsRef.current === 'function') {
                refreshStatsRef.current()
              }
            }
          } catch {}
        }

        es.onerror = () => {
          if (es) es.close()
          reconnectTimer = setTimeout(connectSse, 4000)
        }
      } catch {}
    }

    connectSse()
    return () => {
      if (es) es.close()
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [baseUrl, loadProjects])

  // Limpiar ticker flotante después de 6 segundos
  useEffect(() => {
    if (!agentTicker) return
    const timer = setTimeout(() => setAgentTicker(null), 6000)
    return () => clearTimeout(timer)
  }, [agentTicker])

  // Limpiar interacción activa después de 14 segundos
  useEffect(() => {
    if (!agentInteraction) return
    const timer = setTimeout(() => setAgentInteraction(null), 14000)
    return () => clearTimeout(timer)
  }, [agentInteraction])

  // Obtener datos del grafo del proyecto actualmente seleccionado
  const activeProjectGraph = useMemo(() => {
    if (!activeProject) return { nodes: [], links: [] }
    return graphsByProject[activeProject.id]?.graphData || { nodes: [], links: [] }
  }, [activeProject, graphsByProject])

  // Carga inicial automática del grafo para el proyecto activo si aún no tiene datos cargados
  useEffect(() => {
    if (!activeProjectId || !baseUrl) return
    if (!graphsByProject[activeProjectId]) {
      const p = projects.find((x) => x.id === activeProjectId)
      const q = p?.lastSearchQuery || ''
      Api.buscar(baseUrl, { query: q, top_k: 15, usar_rag: false, project: activeProjectId })
        .then((res) => {
          if (res && res.chunks && res.chunks.length > 0) {
            updateProjectGraph(activeProjectId, res, q)
          }
        })
        .catch(() => {})
    }
  }, [activeProjectId, baseUrl, graphsByProject, projects, updateProjectGraph])

  // Centrar y enfocar en el nodo seleccionado
  const handleSelectNode = useCallback(
    (node) => {
      setSelectedNode(node)
      setShowCodeDetails(false)
      if (node && node.x != null && node.y != null && fgRef.current) {
        const distance = isCompact ? 120 : 180
        fgRef.current.cameraPosition(
          { x: node.x, y: node.y, z: (node.z || 0) + distance },
          { x: node.x, y: node.y, z: node.z || 0 },
          500
        )
      }
    },
    [isCompact],
  )

  // Al cambiar de proyecto activo, transicionar cámara y grafo con coreografía artística
  const handleSelectProject = useCallback(
    async (projId) => {
      if (projId === activeProjectId) return
      setActiveProjectId(projId)
      setSelectedNode(null)
      try {
        await Api.setActiveProject(baseUrl, projId)
      } catch {}

      // 1. Retracción suave de la cámara anterior
      if (fgRef.current) {
        try {
          fgRef.current.cameraPosition(
            { x: 0, y: 0, z: isCompact ? 420 : 580 },
            { x: 0, y: 0, z: 0 },
            350
          )
        } catch {}
      }

      if (!graphsByProject[projId]) {
        try {
          setIsSearching(true)
          const p = projects.find((x) => x.id === projId)
          const q = p?.lastSearchQuery || ''
          const res = await Api.buscar(baseUrl, { query: q, top_k: 15, usar_rag: false, project: projId })
          if (res && res.chunks && res.chunks.length > 0) {
            updateProjectGraph(projId, res, q)
          }
        } catch {} finally {
          setIsSearching(false)
        }
      }

      // 2. Desatar onda holográfica de transición
      setTransitionFx({ startedAt: Date.now(), duration: 2000, type: 'project' })

      setTimeout(() => {
        if (fgRef.current) {
          applyFluidPhysics()
          try {
            fgRef.current.d3VelocityDecay?.(0.35)
            fgRef.current.d3Alpha?.(0.65)
            fgRef.current.d3AlphaDecay?.(0.018)
            fgRef.current.d3AlphaTarget?.(0.012)
            fgRef.current.d3ReheatSimulation?.()
          } catch {}

          // 3. Vuelo panorámico cinematográfico para encuadrar la nueva constelación
          setTimeout(() => {
            try {
              fgRef.current?.zoomToFit(1300, isCompact ? 40 : 70)
            } catch {}
          }, 350)
        }
      }, 180)
    },
    [baseUrl, graphsByProject, projects, updateProjectGraph, applyFluidPhysics, activeProjectId, isCompact],
  )

  useEffect(() => {
    handleSelectProjectRef.current = handleSelectProject
  }, [handleSelectProject])

  // Recargar proyectos manualmente (botón adicional y sincronización)
  const [isReloadingProjects, setIsReloadingProjects] = useState(false)
  const handleReloadProjects = useCallback(async () => {
    setIsReloadingProjects(true)
    try {
      const res = await Api.getProjects(baseUrl)
      if (res && res.ok && Array.isArray(res.projects)) {
        setProjects(res.projects)
        if (res.activeProject) {
          if (!activeProjectIdRef.current || !res.projects.some((p) => p.id === activeProjectIdRef.current)) {
            handleSelectProject(res.activeProject.id)
          }
        }
      }
      await refreshStats()
    } catch (err) {
      console.error('Error al recargar proyectos:', err)
    } finally {
      setTimeout(() => setIsReloadingProjects(false), 500)
    }
  }, [baseUrl, refreshStats, handleSelectProject])

  // Agregar nuevo proyecto
  const handleAddProject = async () => {
    const electronApi = window.embeding
    let pickedPath = newProjectPathInput.trim()

    if (electronApi && typeof electronApi.selectFolder === 'function') {
      const folder = await electronApi.selectFolder()
      if (!folder) return
      pickedPath = folder
    }

    if (!pickedPath) return

    try {
      const res = await Api.addProject(baseUrl, pickedPath)
      if (res && res.ok && res.project) {
        await loadProjects()
        setActiveProjectId(res.project.id)
        setIsAddingProject(false)
        setNewProjectPathInput('')
      }
    } catch (e) {
      alert(`Error al registrar proyecto: ${e.message || String(e)}`)
    }
  }

  // Eliminar proyecto
  const handleDeleteProject = async (e, proj) => {
    e.stopPropagation()
    if (!window.confirm(`¿Remover proyecto "${proj.name}" de Embeding Electron? Los archivos originales no serán modificados.`)) {
      return
    }
    try {
      await Api.deleteProject(baseUrl, proj.id)
      const nextProjects = projects.filter((p) => p.id !== proj.id)
      setProjects(nextProjects)
      if (activeProjectId === proj.id && nextProjects.length > 0) {
        handleSelectProject(nextProjects[0].id)
      }
    } catch (err) {
      alert(`Error al remover: ${err.message}`)
    }
  }

  // Iniciar reindexación del proyecto activo
  const handleStartReindex = async () => {
    if (!activeProject) return
    try {
      setReindexBusy(true)
      const res = await Api.reindexStart(baseUrl, true, activeProject.path)
      if (res.job) setReindexJob(res.job)
    } catch (e) {
      alert(`Error iniciando reindexación: ${e.message}`)
    } finally {
      setReindexBusy(false)
    }
  }

  // Centrar grafo con suavidad
  const handleCenterGraph = () => {
    if (!fgRef.current) return
    try {
      if (selectedNode && selectedNode.x != null && selectedNode.y != null) {
        const distance = isCompact ? 120 : 180
        fgRef.current.cameraPosition(
          { x: selectedNode.x, y: selectedNode.y, z: (selectedNode.z || 0) + distance },
          { x: selectedNode.x, y: selectedNode.y, z: selectedNode.z || 0 },
          500
        )
      } else {
        fgRef.current.zoomToFit(600, 60)
      }
    } catch {}
  }

  // Alternar tamaño de ventana nativa de Windows a 1/4 de pantalla
  const handleToggleNativeQuarter = async () => {
    const electronApi = window.embeding
    if (!electronApi || typeof electronApi.setQuarterScreen !== 'function') {
      alert('La función de ajuste nativo a 1/4 de pantalla se ejecuta dentro de la app de escritorio Electron.')
      return
    }
    try {
      const res = await electronApi.setQuarterScreen('bottom-right')
      setIsNativeQuarter(res.isQuarter)
    } catch {}
  }

  // Alternar "Siempre Encima" (Always On Top)
  const handleToggleAlwaysOnTop = async () => {
    const electronApi = window.embeding
    if (!electronApi || typeof electronApi.toggleAlwaysOnTop !== 'function') return
    try {
      const res = await electronApi.toggleAlwaysOnTop()
      setAlwaysOnTop(res.alwaysOnTop)
    } catch {}
  }

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#070b12] text-slate-100 font-sans select-none flex flex-col">
      {/* BOTÓN FLOTANTE PARA RESTAURAR ENCABEZADO SI SE OCULTÓ PARA MAXIMIZAR ALTO EN 1/4 */}
      {isHeaderHidden && (
        <button
          onClick={() => setIsHeaderHidden(false)}
          className="absolute top-1.5 right-2 z-50 flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-950/85 hover:bg-slate-900 border border-slate-700/60 text-slate-400 hover:text-cyan-300 backdrop-blur-md shadow-lg text-[10px] font-mono transition-all"
          title="Mostrar barra superior"
        >
          <span className="material-symbols-outlined text-[12px]">expand_more</span>
          <span>Panel</span>
        </button>
      )}

      {/* 1. TOP HEADER BAR: ULTRA-COMPACTO EN 1/4 DE PANTALLA PARA PRESERVAR EL ALTO DE LOS NODOS */}
      {!isHeaderHidden && (
        <header
          className={`z-40 w-full px-2 bg-slate-950/95 backdrop-blur-md border-b border-slate-800/40 flex items-center justify-between shrink-0 transition-all ${
            isCompact ? 'h-8 text-xs' : 'h-13 py-1'
          }`}
        >
          {/* Brand & Status */}
          <div className="flex items-center gap-1.5 shrink-0">
            <div
              className={`rounded bg-gradient-to-tr from-cyan-600 to-emerald-400 flex items-center justify-center shadow-md shadow-cyan-500/20 ${
                isCompact ? 'w-4 h-4' : 'w-5 h-5'
              }`}
            >
              <span className={`material-symbols-outlined text-white ${isCompact ? 'text-[11px]' : 'text-[13px]'}`}>
                hub
              </span>
            </div>
            {!isCompact && (
              <span className="font-mono text-xs font-bold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-200 to-slate-200">
                EMBEDING
              </span>
            )}

            <div
              className={`flex items-center gap-1 rounded-full font-mono border ${
                isCompact ? 'px-1 py-0.2 text-[8px]' : 'px-1.5 py-0.5 text-[9px]'
              } ${
                healthOk
                  ? 'bg-emerald-950/60 border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-950/60 border-rose-500/30 text-rose-300'
              }`}
              title="MCP Online"
            >
              <span
                className={`rounded-full ${isCompact ? 'w-1 h-1' : 'w-1.5 h-1.5'} ${
                  healthOk ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
                }`}
              />
              <span>MCP</span>
            </div>
          </div>

          {/* Project Selector: Custom Cybernetic Dropdown */}
          <div className="flex items-center gap-1.5">
            {/* Dropdown Selector Cybernetic */}
            <div className="relative flex items-center gap-1" ref={instanceMenuRef}>
              <button
                type="button"
                onClick={() => setIsInstanceMenuOpen((v) => !v)}
                className={`group flex items-center gap-1.5 rounded-lg bg-slate-900/90 hover:bg-slate-800 border border-cyan-500/40 hover:border-cyan-400 text-slate-200 transition-all shadow-[0_0_8px_rgba(6,182,212,0.12)] active:scale-95 ${
                  isCompact ? 'h-6 px-1.5 text-[10px]' : 'h-7 px-2.5 text-xs'
                }`}
                title="Proyectos"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(6,182,212,0.9)] animate-pulse" />
                <span
                  className={`font-mono font-semibold text-cyan-200 truncate ${
                    isCompact ? 'max-w-[100px] text-[10px]' : 'max-w-[150px] text-xs'
                  }`}
                >
                  {activeProject?.name || 'Instancia'}
                </span>
                {activeProject?.totalChunks != null && (
                  <span
                    className={`font-mono px-1 py-0.2 rounded bg-cyan-950/90 text-cyan-300 border border-cyan-500/30 ${
                      isCompact ? 'text-[8px]' : 'text-[9px]'
                    }`}
                  >
                    {activeProject.totalChunks}
                  </span>
                )}
                <span
                  className={`material-symbols-outlined text-slate-400 group-hover:text-cyan-300 transition-transform duration-200 ${
                    isCompact ? 'text-[12px]' : 'text-[14px]'
                  } ${isInstanceMenuOpen ? 'rotate-180' : ''}`}
                >
                  expand_more
                </span>
              </button>

              {/* Botón para recargar proyectos (sincronizar con MCP) */}
              <button
                type="button"
                onClick={handleReloadProjects}
                disabled={isReloadingProjects}
                className={`group flex items-center justify-center rounded-lg bg-slate-900/90 hover:bg-slate-800 border border-cyan-500/40 hover:border-cyan-400 text-slate-300 hover:text-cyan-200 transition-all shadow-[0_0_8px_rgba(6,182,212,0.1)] active:scale-95 disabled:opacity-50 shrink-0 ${
                  isCompact ? 'h-6 w-6' : 'h-7 w-7'
                }`}
                title="Recargar proyectos (sincronizar con MCP)"
              >
                <span
                  className={`material-symbols-outlined transition-transform duration-500 ${
                    isCompact ? 'text-[12px]' : 'text-[14px]'
                  } ${isReloadingProjects ? 'animate-spin text-cyan-400' : 'group-hover:rotate-180 text-cyan-400/80'}`}
                >
                  refresh
                </span>
              </button>

              {/* Menu Flotante Glassmorphism para Instancias */}
              {isInstanceMenuOpen && (
                <div
                  className={`absolute top-full left-0 mt-1 z-50 p-1.5 rounded-xl bg-slate-950/95 border border-cyan-500/40 backdrop-blur-xl shadow-2xl flex flex-col gap-1 font-mono animate-in fade-in zoom-in-95 ${
                    isCompact ? 'min-w-[210px]' : 'min-w-[260px]'
                  }`}
                >
                  <div className="flex items-center justify-between px-2 py-0.5 border-b border-slate-800/80 text-[8px] text-slate-400 tracking-wider">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-cyan-400">PROYECTOS</span>
                      <span>({projects.length})</span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleReloadProjects()
                      }}
                      disabled={isReloadingProjects}
                      className="flex items-center gap-1 text-[8px] text-cyan-400/80 hover:text-cyan-300 hover:underline px-1 py-0.5 rounded transition-colors"
                      title="Recargar lista de proyectos"
                    >
                      <span className={`material-symbols-outlined text-[10px] ${isReloadingProjects ? 'animate-spin' : ''}`}>
                        refresh
                      </span>
                      <span>Recargar</span>
                    </button>
                  </div>

                  <div className="max-h-56 overflow-y-auto space-y-0.5 scrollbar-thin py-0.5">
                    {projects.map((p) => {
                      const isAct = p.id === activeProject?.id
                      const isAgentActive =
                        recentAgentProjects[p.id] && Date.now() - recentAgentProjects[p.id] < 15000

                      return (
                        <div
                          key={p.id}
                          onClick={() => {
                            handleSelectProject(p.id)
                            setIsInstanceMenuOpen(false)
                          }}
                          className={`group flex items-center justify-between px-2 py-1.5 rounded-lg cursor-pointer transition-all border ${
                            isCompact ? 'text-[10px]' : 'text-[11px]'
                          } ${
                            isAct
                              ? 'bg-cyan-950/60 border-cyan-500/50 text-cyan-200 shadow-[0_0_8px_rgba(6,182,212,0.2)]'
                              : 'bg-transparent border-transparent text-slate-300 hover:bg-slate-900/80 hover:text-slate-100 hover:border-slate-800'
                          }`}
                          title={p.path}
                        >
                          <div className="flex items-center gap-1.5 truncate">
                            {isAgentActive ? (
                              <span className="material-symbols-outlined text-[13px] text-amber-400 animate-bounce">bolt</span>
                            ) : (
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                  isAct ? 'bg-cyan-400 shadow-[0_0_6px_rgba(6,182,212,0.9)]' : 'bg-slate-600'
                                }`}
                              />
                            )}
                            <span
                              className={`font-semibold truncate ${
                                isCompact ? 'max-w-[125px]' : 'max-w-[160px]'
                              }`}
                            >
                              {p.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span
                              className={`text-[8px] px-1 py-0.2 rounded font-mono ${
                                isAct ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-900 text-slate-400'
                              }`}
                            >
                              {p.totalChunks || 0}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDeleteProject(e, p)
                              }}
                              className="opacity-0 group-hover:opacity-100 hover:text-rose-400 transition-opacity p-0.5 text-slate-500"
                              title="Remover proyecto"
                            >
                              <span className="material-symbols-outlined text-[11px]">close</span>
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="pt-1 border-t border-slate-800/80 flex items-center justify-between gap-1">
                    <button
                      onClick={() => {
                        setIsInstanceMenuOpen(false)
                        setIsAddingProject(true)
                      }}
                      className="flex-1 flex items-center justify-center gap-1 py-1 px-1.5 rounded-lg text-[9px] text-cyan-300 bg-cyan-950/40 hover:bg-cyan-900/50 border border-cyan-500/30 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[11px]">add</span>
                      <span>Nueva</span>
                    </button>
                    <button
                      onClick={() => {
                        handleReloadProjects()
                      }}
                      disabled={isReloadingProjects}
                      className="flex items-center justify-center gap-1 py-1 px-1.5 rounded-lg text-[9px] text-cyan-300 bg-cyan-950/40 hover:bg-cyan-900/50 border border-cyan-500/30 transition-colors disabled:opacity-50"
                      title="Recargar lista de proyectos"
                    >
                      <span className={`material-symbols-outlined text-[11px] ${isReloadingProjects ? 'animate-spin' : ''}`}>refresh</span>
                      <span>Recargar</span>
                    </button>
                    <button
                      onClick={() => {
                        setIsInstanceMenuOpen(false)
                        setShowMcpModal(true)
                      }}
                      className="flex items-center justify-center gap-1 py-1 px-1.5 rounded-lg text-[9px] text-emerald-300 bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-500/30 transition-colors"
                      title="MCP"
                    >
                      <span className="material-symbols-outlined text-[11px]">smart_toy</span>
                      <span>MCP</span>
                    </button>
                    <button
                      onClick={() => {
                        setIsInstanceMenuOpen(false)
                        setShowSettingsModal(true)
                      }}
                      className="flex items-center justify-center gap-1 py-1 px-1.5 rounded-lg text-[9px] text-purple-300 bg-purple-950/40 hover:bg-purple-900/50 border border-purple-500/30 transition-colors"
                      title="Modelo"
                    >
                      <span className="material-symbols-outlined text-[11px]">tune</span>
                      <span>Modelo</span>
                    </button>
                  </div>
                </div>
              )}

              {agentInteraction && (
                <span className="px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-500/40 text-amber-300 text-[8px] font-mono animate-pulse truncate max-w-[90px]">
                  ⚡ {agentInteraction.agentName}
                </span>
              )}
            </div>
          </div>

          {/* Tools & Windows Controls */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Buscador optimizado disponible tanto en pantalla normal como en vista 1/4 */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                handleRunSearch()
              }}
              className="relative flex items-center"
            >
              <input
                type="text"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                placeholder={isCompact ? 'Buscar...' : (activeProject ? `Buscar en ${activeProject.name}...` : 'Buscar código...')}
                className={`font-mono text-slate-200 placeholder-slate-500 focus:outline-none transition-all ${
                  isCompact
                    ? 'w-24 focus:w-36 h-6 pl-5 pr-1.5 bg-slate-900/90 border border-slate-700/60 focus:border-cyan-400 rounded text-[10px]'
                    : 'w-44 lg:w-56 h-7 pl-7 pr-2.5 bg-slate-900/80 border border-slate-700/80 focus:border-cyan-500 rounded-lg text-xs focus:ring-1 focus:ring-cyan-500/40'
                }`}
              />
              <span
                className={`material-symbols-outlined absolute pointer-events-none text-slate-400 ${
                  isCompact ? 'left-1 text-[11px]' : 'left-2 text-[13px]'
                }`}
              >
                search
              </span>
            </form>

            {/* Botón Redimensionar a 1/4 de Pantalla */}
            <button
              onClick={handleToggleNativeQuarter}
              className={`flex items-center gap-1 rounded font-mono border transition-all ${
                isCompact
                  ? 'h-6 px-1.5 text-[10px]'
                  : 'h-7 px-2 rounded-lg text-[11px]'
              } ${
                isNativeQuarter || isCompact
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-[0_0_8px_rgba(6,182,212,0.3)]'
                  : 'bg-slate-900 border-slate-700/80 hover:border-cyan-500/50 text-slate-300 hover:text-cyan-200'
              }`}
              title="Modo 1/4"
            >
              <span className={`material-symbols-outlined ${isCompact ? 'text-[12px]' : 'text-[14px]'}`}>
                picture_in_picture
              </span>
              <span className="hidden sm:inline font-semibold">1/4</span>
            </button>

            {/* Botón Fijar Encima (Always On Top) */}
            <button
              onClick={handleToggleAlwaysOnTop}
              className={`rounded border flex items-center justify-center transition-all ${
                isCompact ? 'w-6 h-6' : 'w-7 h-7 rounded-lg'
              } ${
                alwaysOnTop
                  ? 'bg-amber-500/20 border-amber-400 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.3)]'
                  : 'bg-slate-900 border-slate-700/80 text-slate-400 hover:text-slate-200'
              }`}
              title={alwaysOnTop ? 'Desanclar' : 'Fijar'}
            >
              <span className={`material-symbols-outlined ${isCompact ? 'text-[12px]' : 'text-[14px]'}`}>push_pin</span>
            </button>

            {/* Botón Centrar Nodo */}
            <button
              onClick={handleCenterGraph}
              className={`rounded bg-slate-900 border border-slate-700/80 hover:border-slate-600 text-slate-400 hover:text-slate-200 flex items-center justify-center transition-colors ${
                isCompact ? 'w-6 h-6' : 'w-7 h-7 rounded-lg'
              }`}
              title="Centrar"
            >
              <span className={`material-symbols-outlined ${isCompact ? 'text-[13px]' : 'text-[15px]'}`}>
                center_focus_strong
              </span>
            </button>

            {/* Botón Prompt Agente MCP (modo compacto) */}
            <button
              onClick={() => setShowMcpModal(true)}
              className={`rounded border flex items-center justify-center transition-all bg-slate-900 border-slate-700/80 hover:border-cyan-400 text-cyan-300 hover:text-white ${
                isCompact ? 'w-6 h-6' : 'hidden'
              }`}
              title="MCP"
            >
              <span className="material-symbols-outlined text-[13px]">smart_toy</span>
            </button>

            {/* Botón Configuración de Modelo en modo compacto */}
            <button
              onClick={() => setShowSettingsModal(true)}
              className={`rounded border flex items-center justify-center transition-all bg-slate-900 border-slate-700/80 hover:border-purple-400 text-purple-300 hover:text-white ${
                isCompact ? 'w-6 h-6' : 'hidden'
              }`}
              title="Modelo"
            >
              <span className="material-symbols-outlined text-[13px]">tune</span>
            </button>

            {/* En modo 1/4, botón para ocultar encabezado */}
            {isCompact && (
              <button
                onClick={() => setIsHeaderHidden(true)}
                className="w-6 h-6 rounded bg-slate-900/60 hover:bg-slate-800 text-slate-400 hover:text-cyan-300 flex items-center justify-center transition-colors"
                title="Ocultar barra"
              >
                <span className="material-symbols-outlined text-[13px]">expand_less</span>
              </button>
            )}

            {!isCompact && (
              <>
                {/* Botón Configuración de Modelo */}
                <button
                  onClick={() => setShowSettingsModal(true)}
                  className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-mono bg-purple-950/40 border border-purple-500/40 hover:border-purple-400 text-purple-200 hover:text-white transition-all shadow-sm group"
                  title="Modelo"
                >
                  <span className="material-symbols-outlined text-[14px] text-purple-400 group-hover:rotate-45 transition-transform">
                    tune
                  </span>
                  <span>
                    {settingsValues.EMBEDDING_PROVIDER === 'gemma-local'
                      ? 'Gemma Local'
                      : settingsValues.EMBEDDING_PROVIDER === 'gemma-api'
                      ? 'Gemma API'
                      : settingsValues.EMBEDDING_PROVIDER === 'voyage'
                      ? 'Voyage AI'
                      : 'Hash Local'}
                  </span>
                </button>

                {/* Botón Agente MCP */}
                <button
                  onClick={() => setShowMcpModal(true)}
                  className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-mono bg-cyan-950/40 border border-cyan-500/40 hover:border-cyan-400 text-cyan-200 hover:text-white transition-all shadow-sm group"
                  title="MCP"
                >
                  <span className="material-symbols-outlined text-[14px] text-cyan-400 group-hover:scale-110 transition-transform">
                    smart_toy
                  </span>
                  <span>MCP</span>
                </button>

                {/* Botón Reindexar */}
                <button
                  onClick={handleStartReindex}
                  disabled={reindexBusy || !activeProject}
                  className={`flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] font-mono border transition-all ${
                    reindexBusy
                      ? 'bg-amber-950/40 border-amber-500/40 text-amber-300 animate-pulse'
                      : projectStats?.dimension_mismatch
                      ? 'bg-amber-950/60 border-amber-500 text-amber-300 animate-pulse ring-1 ring-amber-500/50'
                      : 'bg-slate-900 border-slate-700/80 hover:border-cyan-500/50 text-slate-300 hover:text-cyan-200'
                  }`}
                  title={projectStats?.dimension_mismatch ? `Índice (${projectStats.embedding_dim}D) difiere del modelo (${projectStats.provider_dim}D). Haz clic para sincronizar.` : 'Indexar'}
                >
                  <span className={`material-symbols-outlined text-[13px] ${reindexBusy ? 'animate-spin' : ''}`}>
                    {projectStats?.dimension_mismatch ? 'sync_problem' : 'sync'}
                  </span>
                  <span>{projectStats?.dimension_mismatch ? 'Reindexar' : 'Indexar'}</span>
                </button>

                {/* Botón Memorias */}
                <button
                  onClick={() => setShowMemoriesModal((v) => !v)}
                  className="flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] font-mono bg-slate-900 border border-slate-700/80 hover:border-emerald-500/40 text-slate-300 hover:text-emerald-300 transition-all"
                  title="Memorias"
                >
                  <span className="material-symbols-outlined text-[13px] text-emerald-400">psychology</span>
                  <span>~{agentMemoryStats.total_tokens_saved}</span>
                </button>
              </>
            )}
          </div>
        </header>
      )}

      {/* 2. MAIN VIEWPORT: GRAFO CON NODOS Y ARISTAS PROPORCIONADOS Y EFECTOS ARTÍSTICOS */}
      <main ref={graphHostRef} className="relative flex-1 w-full h-full overflow-hidden bg-gradient-to-b from-[#080d17] via-[#05080f] to-[#03060a]">
        {graphHostSize.w > 0 && graphHostSize.h > 0 ? (
          <ForceGraph3D
            ref={fgRef}
            graphData={activeProjectGraph}
            width={graphHostSize.w}
            height={graphHostSize.h}
            backgroundColor="rgba(0,0,0,0)"
            showNavInfo={false}
            nodeRelSize={3}
            nodeThreeObjectExtend={false}
            warmupTicks={40}
            cooldownTicks={Infinity}
            d3VelocityDecay={0.35}
            d3AlphaDecay={0.018}
            rendererConfig={{ powerPreference: 'high-performance', antialias: true, alpha: true }}
            nodeThreeObject={(node) => {
              const kind = node.kind
              const rel = safePercent01(node.relevance)
              const isSelected = Boolean(selectedNode && selectedNode.id === node.id)
              const isAgentManipulated = Boolean(
                agentInteraction &&
                agentInteraction.targetNodeIds &&
                agentInteraction.targetNodeIds.has(node.id) &&
                Date.now() - agentInteraction.timestamp < 14000
              )

              let color = '#38bdf8'
              let sphereRadius = 3.2
              let labelText = node.label || ''
              let badgeText = ''

              if (kind === 'chunk') {
                const style = getChunkTypeStyle(node.chunkType)
                color = isSelected ? '#ffffff' : (isAgentManipulated ? '#38bdf8' : style.color)
                sphereRadius = (isCompact ? 1.5 : 2.0) + rel * (isCompact ? 1.0 : 1.6)
                if (isSelected) sphereRadius += 1.4
                labelText = node.symbolName || node.label || ''
                badgeText = style.label
              } else if (kind === 'file') {
                color = isSelected ? '#ffffff' : (isAgentManipulated ? '#38bdf8' : '#38bdf8')
                sphereRadius = (isCompact ? 2.5 : 3.2) + rel * (isCompact ? 1.2 : 1.8)
                if (isSelected) sphereRadius += 1.5
                labelText = node.label || ''
                badgeText = 'FILE'
              } else if (kind === 'index') {
                color = '#a855f7'
                sphereRadius = isCompact ? 4.0 : 5.4
                if (isSelected) sphereRadius += 1.6
                labelText = activeProject ? activeProject.name : 'INDEX'
                badgeText = 'HUB'
              }

              // REGLA ESTRICTA: Solo el nodo raíz (INDEX / HUB) es principal y muestra nombre por defecto.
              // TODOS los demás nodos (archivos y chunks) están ocultos y solo muestran su nombre al hacer click.
              const isPrincipal = kind === 'index'
              const shouldShowLabel = isPrincipal || isSelected

              // Clave de caché para reutilizar la malla Three.js en GPU con 0 overhead
              const cacheKey = `${color}_${Math.round(sphereRadius * 10)}_${isSelected ? 1 : 0}_${isAgentManipulated ? 1 : 0}_${shouldShowLabel ? 1 : 0}`
              if (node.__cachedGroup && node.__cacheKey === cacheKey) {
                return node.__cachedGroup
              }

              const group = new THREE.Group()

              // 1. Núcleo esférico 3D con emisión de luz
              const coreMesh = new THREE.Mesh(
                SHARED_SPHERE_GEOM,
                getCachedThreeMaterial('core', color, isSelected, isAgentManipulated)
              )
              coreMesh.scale.setScalar(sphereRadius)
              group.add(coreMesh)

              // 2. Halo 3D sutil holográfico (le da volumen y profundidad cósmica)
              const glowMesh = new THREE.Mesh(
                SHARED_GLOW_GEOM,
                getCachedThreeMaterial('glow', color, isSelected, isAgentManipulated)
              )
              glowMesh.scale.setScalar(sphereRadius * (isSelected ? 1.4 : 1.22))
              group.add(glowMesh)

              // 3. Anillo orbital si está seleccionado o manipulado por IA
              if (isSelected || isAgentManipulated) {
                const ringMesh = new THREE.Mesh(
                  SHARED_RING_GEOM,
                  getCachedThreeMaterial('ring', color, isSelected, isAgentManipulated)
                )
                ringMesh.scale.setScalar(sphereRadius)
                group.add(ringMesh)
              }

              // 4. Etiqueta solo si es principal (INDEX) o está clickeado (isSelected)
              if (shouldShowLabel && labelText) {
                const maxChars = isCompact ? 16 : 24
                const displayLabel = labelText.length > maxChars ? labelText.slice(0, maxChars - 1) + '…' : labelText
                const fullText = isSelected && badgeText ? `[${badgeText}] ${displayLabel}` : displayLabel

                let sprite = node.__cachedSprite
                if (!sprite || sprite.__text !== fullText) {
                  sprite = new SpriteText(fullText)
                  sprite.__text = fullText
                  sprite.color = isSelected ? '#ffffff' : (isAgentManipulated ? '#38bdf8' : (kind === 'file' ? '#bae6fd' : '#e2e8f0'))
                  sprite.backgroundColor = isSelected ? 'rgba(15, 23, 42, 0.95)' : 'rgba(7, 11, 20, 0.85)'
                  sprite.borderColor = isSelected ? '#ffffff' : color
                  sprite.borderWidth = 0.5
                  sprite.borderRadius = 2
                  sprite.padding = [1.2, 3]
                  sprite.fontFace = 'JetBrains Mono, monospace'
                  sprite.fontWeight = isSelected ? 'bold' : '600'
                  node.__cachedSprite = sprite
                }

                const baseTextHeight = isCompact ? 2.1 : 2.7
                sprite.textHeight = isSelected ? baseTextHeight * 1.15 : baseTextHeight
                sprite.position.set(0, sphereRadius + (isCompact ? 2.0 : 2.6), 0)
                sprite.material.depthWrite = false

                group.add(sprite)
              }

              node.__cachedGroup = group
              node.__cacheKey = cacheKey
              return group
            }}
            linkWidth={(l) => {
              const isConnSelected = selectedNode && (l.source?.id === selectedNode.id || l.target?.id === selectedNode.id)
              if (isConnSelected) return isCompact ? 1.6 : 2.2
              return isCompact ? 0.65 : 0.9
            }}
            linkColor={(l) => {
              const isConnSelected = selectedNode && (l.source?.id === selectedNode.id || l.target?.id === selectedNode.id)
              if (isConnSelected) return 'rgba(6, 182, 212, 1.0)'
              if (selectedNode) return 'rgba(56, 189, 248, 0.12)'
              if (l.type === 'index→file') return 'rgba(192, 132, 252, 0.85)'   // Púrpura sólido y brillante
              if (l.type === 'co-occurrence') return 'rgba(56, 189, 248, 0.78)' // Cian nítido entre archivos
              if (l.type === 'chunk→chunk') return 'rgba(16, 185, 129, 0.78)'   // Esmeralda nítido intra-archivo
              if (l.type === 'file→chunk') return 'rgba(56, 189, 248, 0.72)'    // Azul cian definido
              return 'rgba(168, 85, 247, 0.68)'                                 // Púrpura definido todos contra todos
            }}
            linkCurvature={0}
            linkDirectionalParticles={0}
            onBackgroundClick={() => setSelectedNode(null)}
            onNodeClick={handleSelectNode}
          />
        ) : null}

        {/* 3. MINI-CARD FLOTANTE CUANDO UN NODO ESTÁ SELECCIONADO (OPTIMIZADA PARA 1/4 DE PANTALLA) */}
        {selectedNode && (
          <div
            className={`absolute z-30 pointer-events-auto bg-slate-950/95 border border-cyan-500/40 backdrop-blur-xl shadow-2xl flex flex-col font-mono animate-slide-up mx-auto transition-all ${
              isCompact
                ? 'bottom-1.5 left-1.5 right-1.5 p-2 rounded-lg gap-1.5 max-w-lg'
                : 'bottom-3 left-3 right-3 p-3 rounded-xl gap-2 max-w-xl'
            }`}
          >
            {/* Fila principal: Categoría, Símbolo, Match % y Controles */}
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5 truncate">
                {selectedNode.kind === 'chunk' ? (
                  (() => {
                    const s = getChunkTypeStyle(selectedNode.chunkType)
                    return (
                      <span className={`px-1 py-0.2 rounded text-[9px] font-bold border ${s.bg}`}>
                        {s.label}
                      </span>
                    )
                  })()
                ) : (
                  <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-sky-950/80 text-sky-300 border border-sky-500/50">
                    {selectedNode.kind.toUpperCase()}
                  </span>
                )}
                <span className="font-bold text-slate-100 truncate text-[11px] sm:text-xs">
                  {selectedNode.symbolName || selectedNode.label}
                </span>
                <span className="text-emerald-400 text-[10px] sm:text-[11px] font-semibold shrink-0">
                  {formatMatch(selectedNode.relevance)}
                </span>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {selectedNode.chunkData && (
                  <button
                    onClick={() => {
                      setShowCodeDetails((v) => !v)
                      setIsCardCollapsed(false)
                    }}
                    className="px-1.5 py-0.5 rounded bg-cyan-950/60 border border-cyan-500/40 text-cyan-200 text-[9px] hover:bg-cyan-900/60 transition-colors"
                  >
                    {showCodeDetails ? 'Código ▲' : 'Código ▼'}
                  </button>
                )}
                {/* Botón para colapsar/minimizar la tarjeta */}
                <button
                  onClick={() => setIsCardCollapsed((v) => !v)}
                  className="w-5 h-5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 flex items-center justify-center transition-colors"
                  title={isCardCollapsed ? 'Expandir' : 'Minimizar'}
                >
                  <span className="material-symbols-outlined text-[13px]">
                    {isCardCollapsed ? 'unfold_more' : 'unfold_less'}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setSelectedNode(null)
                    setShowCodeDetails(false)
                    setIsCardCollapsed(false)
                  }}
                  className="w-5 h-5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 flex items-center justify-center transition-colors"
                  title="Cerrar"
                >
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              </div>
            </div>

            {/* Fila secundaria: Ruta de archivo y líneas (oculta al estar minimizada) */}
            {!isCardCollapsed && (
              <div className="flex items-center justify-between text-[9px] sm:text-[10px] text-slate-400 truncate">
                <span className="truncate" title={selectedNode.filePath || selectedNode.path}>
                  {selectedNode.filePath || selectedNode.path}
                </span>
                {selectedNode.chunkData?.linea_inicio != null && (
                  <span className="text-cyan-300 shrink-0 ml-1.5 font-mono">
                    L{selectedNode.chunkData.linea_inicio} - L{selectedNode.chunkData.linea_fin || '?'}
                  </span>
                )}
              </div>
            )}

            {/* Bloque de código expandible con altura adaptativa para 1/4 de pantalla */}
            {!isCardCollapsed && showCodeDetails && selectedNode.chunkData && (
              <div className="space-y-1 pt-1 border-t border-slate-800/80">
                <div className="flex justify-between items-center text-[9px]">
                  <span className="text-slate-500">{selectedNode.scope || 'Código'}</span>
                  <button
                    onClick={() => {
                      const code = selectedNode.chunkData.codigo_puro || selectedNode.chunkData.contenido
                      copyToClipboard(code).then(() => {
                        setCodeCopied(true)
                        setTimeout(() => setCodeCopied(false), 1800)
                      })
                    }}
                    className="text-cyan-300 hover:text-cyan-200"
                  >
                    {codeCopied ? '✓ Copiado' : 'Copiar'}
                  </button>
                </div>
                <pre
                  className={`p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] text-slate-300 overflow-x-auto scrollbar-thin leading-relaxed ${
                    isCompact ? 'max-h-28' : 'max-h-44'
                  }`}
                >
                  <code>{selectedNode.chunkData.codigo_puro || selectedNode.chunkData.contenido}</code>
                </pre>
              </div>
            )}
          </div>
        )}

        {/* 4. FLOATING HUD DEL AGENTE (COMPACTO Y NO INTRUSIVO EN 1/4) */}
        {!selectedNode && agentInteraction && (
          <div
            className={`absolute z-30 pointer-events-none flex items-center justify-between rounded-lg bg-slate-950/90 border border-cyan-500/40 backdrop-blur-md shadow-lg font-mono animate-fade-in mx-auto ${
              isCompact
                ? 'bottom-1.5 left-1.5 right-1.5 p-1.5 text-[10px] max-w-sm'
                : 'bottom-3 left-3 right-3 p-2 text-[11px] max-w-lg'
            }`}
          >
            <div className="flex items-center gap-1.5 truncate">
              <span className="material-symbols-outlined text-amber-400 text-xs animate-spin">smart_toy</span>
              <span className="font-bold text-cyan-300">{agentInteraction.agentName}</span>
              <span className="text-slate-500">•</span>
              <span className="text-amber-300 font-semibold truncate max-w-[140px] sm:max-w-[200px]">
                "{agentInteraction.query}"
              </span>
            </div>
            {agentInteraction.tokensSaved ? (
              <span className="px-1 py-0.2 rounded bg-emerald-950/80 border border-emerald-500/30 text-emerald-300 text-[9px] font-bold shrink-0 ml-1">
                +{agentInteraction.tokensSaved} tok
              </span>
            ) : null}
          </div>
        )}

        {/* Empty state / Loading Overlay */}
        {activeProjectGraph.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-4">
            <div className="bg-slate-950/85 border border-slate-800/80 backdrop-blur-xl p-6 rounded-2xl max-w-sm w-full text-center shadow-2xl pointer-events-auto space-y-3">
              {isSearching ? (
                <>
                  <div className="w-8 h-8 mx-auto border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                  <div className="font-mono text-xs text-cyan-300 font-medium">Buscando...</div>
                </>
              ) : (
                <>
                  <div className="w-9 h-9 mx-auto rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
                    <span className="material-symbols-outlined text-lg">bubble_chart</span>
                  </div>
                  <div className="font-mono text-xs font-bold text-slate-200">
                    {activeProject?.name || 'Grafo Semántico'}
                  </div>
                  <p className="text-[10px] text-slate-400 font-mono">
                    Busca código o consulta vía MCP.
                  </p>
                  <button
                    onClick={() => handleRunSearch('service class function')}
                    className="w-full py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 font-mono text-[11px] font-semibold transition-all"
                  >
                    Explorar
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* 5. ADD PROJECT MODAL */}
      {isAddingProject && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-950 border border-slate-800 rounded-xl max-w-md w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-slate-200">Nuevo Proyecto</h3>
              <button onClick={() => setIsAddingProject(false)} className="text-slate-400 hover:text-slate-200">
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Directorio en Disco</label>
              <input
                type="text"
                value={newProjectPathInput}
                onChange={(e) => setNewProjectPathInput(e.target.value)}
                placeholder="C:/proyectos/mi-app"
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg font-mono text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setIsAddingProject(false)}
                className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs font-mono"
              >
                Cancelar
              </button>
              <button
                onClick={handleAddProject}
                className="px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-mono text-xs font-semibold"
              >
                Añadir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6. MEMORIES MODAL */}
      {showMemoriesModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-950 border border-slate-800 rounded-2xl max-w-xl w-full p-6 space-y-4 shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-emerald-400 text-[18px]">psychology</span>
                <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-slate-200">
                  Memorias • {activeProject?.name || 'Proyecto'}
                </h3>
              </div>
              <button onClick={() => setShowMemoriesModal(false)} className="text-slate-400 hover:text-slate-200">
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
            <div className="text-xs text-slate-400 font-mono flex justify-between bg-slate-900/60 px-3 py-2 rounded-lg border border-slate-800">
              <span>Memorias: <strong className="text-slate-200">{agentMemories.length}</strong></span>
              <span>Tokens ahorrados: <strong className="text-emerald-400">~{agentMemoryStats.total_tokens_saved}</strong></span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {agentMemories.length === 0 ? (
                <div className="text-center py-8 text-xs font-mono text-slate-500">
                  Sin notas persistentes aún.
                </div>
              ) : (
                agentMemories.map((m) => (
                  <div key={m.key} className="p-2.5 rounded-lg bg-slate-900/40 border border-slate-800/80 space-y-1 font-mono text-xs">
                    <div className="flex justify-between items-center">
                      <span className="font-bold text-cyan-300">{m.key}</span>
                      <span className="text-[10px] text-slate-500">{m.accessCount}x</span>
                    </div>
                    <p className="text-slate-300 text-[11px] leading-relaxed">{m.content}</p>
                    {m.filePath ? <div className="text-[10px] text-slate-500">Archivo: {m.filePath}</div> : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 7. MCP AGENT CONFIGURATION / PROMPT MODAL */}
      {showMcpModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 animate-fade-in font-mono">
          <div className="bg-slate-950 border border-cyan-500/30 rounded-2xl max-w-3xl w-full p-4 sm:p-6 space-y-4 shadow-[0_0_50px_rgba(6,182,212,0.15)] max-h-[92vh] flex flex-col">
            {/* Header del Modal */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-cyan-950/80 border border-cyan-500/40 flex items-center justify-center text-cyan-300">
                  <span className="material-symbols-outlined text-[18px]">smart_toy</span>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                    Configuración & Prompts de Agente MCP
                    {activeProject && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-950 border border-cyan-500/30 text-cyan-300 font-normal">
                        {activeProject.name}
                      </span>
                    )}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Instalación, directivas, benchmark de tokens y reglas para IDEs (Cursor, Windsurf, Claude, Cline)
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowMcpModal(false)}
                className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-900 transition-colors"
                title="Cerrar"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            {/* Pestañas Exclusivas para los Prompts y Reglas */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-2 text-xs">
              <div className="flex items-center gap-1.5 overflow-x-auto">
                {[
                  { id: 'prompt', label: 'Prompt', icon: 'chat' },
                  { id: 'rules', label: '.cursorrules', icon: 'gavel' },
                  { id: 'config', label: 'mcp.json', icon: 'data_object' },
                  { id: 'cli', label: 'Claude CLI', icon: 'terminal' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveMcpTab(tab.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all shrink-0 font-medium ${
                      activeMcpTab === tab.id
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 shadow-[0_0_10px_rgba(6,182,212,0.2)]'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[14px]">{tab.icon}</span>
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Contenedor de Código de la Pestaña Activa con Barra Superior y Copiado */}
            <div className="relative flex-1 bg-slate-900/80 border border-slate-800/80 rounded-xl overflow-hidden min-h-[380px] flex flex-col shadow-inner">
              <div className="flex items-center justify-between px-3.5 py-2 bg-slate-950/90 border-b border-slate-800/60 text-xs shrink-0">
                <span className="text-[11px] text-slate-400 font-mono">
                  {activeMcpTab === 'prompt' && 'Prompt maestro (Instalación, directivas, test comparativo de tokens y memoria)'}
                  {activeMcpTab === 'rules' && 'Directivas de optimización y reglas de tokens (.cursorrules / CLAUDE.md)'}
                  {activeMcpTab === 'config' && 'Configuración de servidor para .cursor/mcp.json o Claude Desktop'}
                  {activeMcpTab === 'cli' && 'Comando terminal rápido para Claude Code CLI'}
                </span>
                <button
                  onClick={() => {
                    const textToCopy =
                      activeMcpTab === 'prompt'
                        ? fullAgentPrompt
                        : activeMcpTab === 'rules'
                        ? agentRulesContent
                        : activeMcpTab === 'config'
                        ? mcpJsonConfig
                        : claudeCliCommand
                    handleCopyText(textToCopy, activeMcpTab)
                  }}
                  className={`px-3 py-1 rounded-md text-[11px] font-mono flex items-center gap-1.5 transition-all font-semibold ${
                    mcpCopyStatus === activeMcpTab
                      ? 'bg-emerald-600 text-white shadow-[0_0_8px_rgba(16,185,129,0.4)]'
                      : 'bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 hover:border-cyan-400'
                  }`}
                >
                  <span className="material-symbols-outlined text-[13px]">
                    {mcpCopyStatus === activeMcpTab ? 'check' : 'content_copy'}
                  </span>
                  <span>{mcpCopyStatus === activeMcpTab ? '¡Copiado!' : 'Copiar'}</span>
                </button>
              </div>

              <pre className="p-4 text-[11px] leading-relaxed text-slate-300 font-mono overflow-auto flex-1 select-all whitespace-pre-wrap scrollbar-thin">
                {activeMcpTab === 'prompt' && fullAgentPrompt}
                {activeMcpTab === 'rules' && agentRulesContent}
                {activeMcpTab === 'config' && mcpJsonConfig}
                {activeMcpTab === 'cli' && claudeCliCommand}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* 8. EMBEDDING MODEL SETTINGS MODAL */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 animate-fade-in font-mono">
          <div className="bg-slate-950 border border-purple-500/30 rounded-2xl max-w-2xl w-full p-4 sm:p-6 space-y-4 shadow-[0_0_50px_rgba(168,85,247,0.15)] max-h-[92vh] flex flex-col">
            {/* Header del Modal */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-purple-950/80 border border-purple-500/40 flex items-center justify-center text-purple-300">
                  <span className="material-symbols-outlined text-[18px]">tune</span>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                    Motor de Embeddings
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-950 border border-purple-500/30 text-purple-300 font-normal">
                      {settingsValues.EMBEDDING_PROVIDER === 'gemma-local'
                        ? 'Gemma Local'
                        : settingsValues.EMBEDDING_PROVIDER === 'gemma-api'
                        ? 'Gemma API'
                        : settingsValues.EMBEDDING_PROVIDER === 'voyage'
                        ? 'Voyage AI'
                        : 'Hash Local'}
                    </span>
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Inferencia local on-device o API remota
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="text-slate-400 hover:text-slate-100 p-1 rounded-lg hover:bg-slate-900 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {/* Selector de Modo / Proveedor (Radio Cards) */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Proveedor
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {/* Opción 1: EmbeddingGemma Local */}
                  <div
                    onClick={() =>
                      setSettingsValues((prev) => ({ ...prev, EMBEDDING_PROVIDER: 'gemma-local' }))
                    }
                    className={`p-2.5 rounded-xl border cursor-pointer transition-all ${
                      settingsValues.EMBEDDING_PROVIDER === 'gemma-local'
                        ? 'bg-purple-950/40 border-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.2)]'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <div className="flex items-center gap-1.5 font-bold text-xs text-purple-200">
                        <span className="material-symbols-outlined text-[15px] text-purple-400">memory</span>
                        <span>EmbeddingGemma Local</span>
                      </div>
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-950 border border-emerald-500/30 text-emerald-300 font-semibold">
                        Offline
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      Inferencia on-device aislada (ONNX Q4/Q8, ~270M, sin internet).
                    </p>
                  </div>

                  {/* Opción 2: EmbeddingGemma API Remota */}
                  <div
                    onClick={() =>
                      setSettingsValues((prev) => ({ ...prev, EMBEDDING_PROVIDER: 'gemma-api' }))
                    }
                    className={`p-2.5 rounded-xl border cursor-pointer transition-all ${
                      settingsValues.EMBEDDING_PROVIDER === 'gemma-api'
                        ? 'bg-cyan-950/40 border-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.2)]'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <div className="flex items-center gap-1.5 font-bold text-xs text-cyan-200">
                        <span className="material-symbols-outlined text-[15px] text-cyan-400">cloud_sync</span>
                        <span>Gemma API Remota</span>
                      </div>
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-cyan-950 border border-cyan-500/30 text-cyan-300 font-semibold">
                        HTTP
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      Endpoint HTTP (vLLM, Ollama, OpenAI-compatible).
                    </p>
                  </div>

                  {/* Opción 3: Voyage AI */}
                  <div
                    onClick={() =>
                      setSettingsValues((prev) => ({ ...prev, EMBEDDING_PROVIDER: 'voyage' }))
                    }
                    className={`p-2.5 rounded-xl border cursor-pointer transition-all ${
                      settingsValues.EMBEDDING_PROVIDER === 'voyage'
                        ? 'bg-amber-950/40 border-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.2)]'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <div className="flex items-center gap-1.5 font-bold text-xs text-amber-200">
                        <span className="material-symbols-outlined text-[15px] text-amber-400">api</span>
                        <span>Voyage AI</span>
                      </div>
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-amber-950 border border-amber-500/30 text-amber-300 font-semibold">
                        Cloud
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      API externa voyage-code-3 (1024D). Requiere API Key.
                    </p>
                  </div>

                  {/* Opción 4: Hash Semántico Local */}
                  <div
                    onClick={() =>
                      setSettingsValues((prev) => ({ ...prev, EMBEDDING_PROVIDER: 'local' }))
                    }
                    className={`p-2.5 rounded-xl border cursor-pointer transition-all ${
                      settingsValues.EMBEDDING_PROVIDER === 'local'
                        ? 'bg-slate-800/80 border-slate-400 shadow-[0_0_12px_rgba(148,163,184,0.15)]'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <div className="flex items-center gap-1.5 font-bold text-xs text-slate-200">
                        <span className="material-symbols-outlined text-[15px] text-slate-400">bolt</span>
                        <span>Hash Local</span>
                      </div>
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 font-semibold">
                        Sin IA
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      Hash determinístico (512D). Sin consumo de RAM.
                    </p>
                  </div>
                </div>
              </div>

              {/* Parámetros Específicos para Gemma Local */}
              {settingsValues.EMBEDDING_PROVIDER === 'gemma-local' && (
                <div className="p-3 rounded-xl bg-slate-900/50 border border-purple-500/20 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-purple-200">EmbeddingGemma Local</span>
                    <span className="text-[10px] text-purple-400 font-mono">MRL</span>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] text-slate-400 font-mono uppercase tracking-wider flex items-center justify-between">
                      <span>Dimensión MRL</span>
                      <span className="text-purple-300 font-bold">{settingsValues.GEMMA_LOCAL_DIMENSION || '512'}D</span>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setSettingsValues((prev) => ({ ...prev, GEMMA_LOCAL_DIMENSION: '512' }))
                        }
                        className={`py-1.5 px-2.5 rounded-lg text-xs font-mono border text-left flex flex-col gap-0.5 transition-all ${
                          (settingsValues.GEMMA_LOCAL_DIMENSION || '512') === '512'
                            ? 'bg-purple-950/60 border-purple-400 text-purple-200'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}
                      >
                        <span className="font-bold">512D</span>
                        <span className="text-[10px] text-slate-500">Balance óptimo</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSettingsValues((prev) => ({ ...prev, GEMMA_LOCAL_DIMENSION: '256' }))
                        }
                        className={`py-1.5 px-2.5 rounded-lg text-xs font-mono border text-left flex flex-col gap-0.5 transition-all ${
                          settingsValues.GEMMA_LOCAL_DIMENSION === '256'
                            ? 'bg-purple-950/60 border-purple-400 text-purple-200'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}
                      >
                        <span className="font-bold">256D</span>
                        <span className="text-[10px] text-slate-500">Mayor velocidad</span>
                      </button>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800/60 space-y-2">
                    {localModelStatus?.installed ? (
                      <div className="flex items-center justify-between text-[11px] text-emerald-400 font-mono bg-emerald-950/40 border border-emerald-500/30 rounded-lg p-2">
                        <div className="flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-[15px]">check_circle</span>
                          <span>Modelo ONNX listo en disco (~320MB)</span>
                        </div>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-300 font-semibold">
                          Offline OK
                        </span>
                      </div>
                    ) : isDownloadingModel ? (
                      <div className="p-2.5 rounded-lg bg-purple-950/40 border border-purple-500/40 space-y-1.5">
                        <div className="flex items-center justify-between text-xs text-purple-200 font-mono">
                          <span className="flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[14px] animate-spin text-purple-400">sync</span>
                            <span>Descargando modelo...</span>
                          </span>
                          <span className="font-bold">{downloadModelProgress?.progress || 0}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-purple-500 transition-all duration-300 rounded-full"
                            style={{ width: `${downloadModelProgress?.progress || 0}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono truncate">
                          {downloadModelProgress?.message || 'Descargando desde Hugging Face (onnx-community)...'}
                        </div>
                      </div>
                    ) : (
                      <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-500/30 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="text-[11px] font-semibold text-amber-200 flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[15px] text-amber-400">cloud_download</span>
                            <span>Modelo no instalado todavía</span>
                          </div>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-950 border border-amber-500/40 text-amber-300 font-mono">
                            ~320MB
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 leading-relaxed">
                          Descarga única de los componentes ONNX de EmbeddingGemma para inferencia local sin conexión.
                        </p>
                        <button
                          type="button"
                          onClick={handleStartModelDownload}
                          disabled={isDownloadingModel}
                          className="w-full py-1.5 px-3 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-sm cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[15px]">download</span>
                          <span>Descargar Modelo Local</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Parámetros Específicos para Gemma API Remota */}
              {settingsValues.EMBEDDING_PROVIDER === 'gemma-api' && (
                <div className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-cyan-200">Endpoint Remoto</span>
                    <span className="text-[10px] text-cyan-400 font-mono">HTTP</span>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">URL Base</label>
                    <input
                      type="text"
                      value={settingsValues.GEMMA_API_URL || ''}
                      onChange={(e) =>
                        setSettingsValues((prev) => ({ ...prev, GEMMA_API_URL: e.target.value }))
                      }
                      placeholder="http://localhost:8000/v1"
                      className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-cyan-400 font-mono"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">
                      API Key / Bearer Token
                    </label>
                    <div className="relative">
                      <input
                        type={showGemmaKey ? 'text' : 'password'}
                        value={settingsSecrets.GEMMA_API_KEY}
                        onChange={(e) =>
                          setSettingsSecrets((prev) => ({ ...prev, GEMMA_API_KEY: e.target.value }))
                        }
                        placeholder={
                          hasSecrets.GEMMA_API_KEY
                            ? 'Token guardado •••••••• (escribe para cambiar)'
                            : 'Bearer token o api key si aplica'
                        }
                        className="w-full pl-2.5 pr-8 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-cyan-400 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowGemmaKey((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 p-0.5"
                        title={showGemmaKey ? 'Ocultar clave' : 'Mostrar clave'}
                      >
                        <span className="material-symbols-outlined text-[15px]">
                          {showGemmaKey ? 'visibility_off' : 'visibility'}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">Modelo</label>
                      <input
                        type="text"
                        value={settingsValues.GEMMA_MODEL_NAME || ''}
                        onChange={(e) =>
                          setSettingsValues((prev) => ({ ...prev, GEMMA_MODEL_NAME: e.target.value }))
                        }
                        placeholder="google/embeddinggemma-270m"
                        className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-cyan-400 font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">Dimensión MRL</label>
                      <select
                        value={settingsValues.GEMMA_LOCAL_DIMENSION || '512'}
                        onChange={(e) =>
                          setSettingsValues((prev) => ({ ...prev, GEMMA_LOCAL_DIMENSION: e.target.value }))
                        }
                        className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-cyan-400 font-mono"
                      >
                        <option value="256">256D</option>
                        <option value="512">512D</option>
                        <option value="768">768D</option>
                        <option value="1024">1024D</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Parámetros Específicos para Voyage AI */}
              {settingsValues.EMBEDDING_PROVIDER === 'voyage' && (
                <div className="p-3 rounded-xl bg-slate-900/50 border border-amber-500/20 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-amber-200">Voyage AI</span>
                    <span className="text-[10px] text-amber-400 font-mono">voyage-code-3 (1024D)</span>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">API Key</label>
                    <div className="relative">
                      <input
                        type={showVoyageKey ? 'text' : 'password'}
                        value={settingsSecrets.VOYAGE_API_KEY}
                        onChange={(e) =>
                          setSettingsSecrets((prev) => ({ ...prev, VOYAGE_API_KEY: e.target.value }))
                        }
                        placeholder={
                          hasSecrets.VOYAGE_API_KEY
                            ? 'Clave guardada •••••••• (escribe para cambiar)'
                            : 'pa-xxxxxxxxxxxxxxxx'
                        }
                        className="w-full pl-2.5 pr-8 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-amber-400 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowVoyageKey((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 p-0.5"
                        title={showVoyageKey ? 'Ocultar clave' : 'Mostrar clave'}
                      >
                        <span className="material-symbols-outlined text-[15px]">
                          {showVoyageKey ? 'visibility_off' : 'visibility'}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Segundo Plano & Sistema (System Tray) */}
              <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[16px] text-purple-400">desktop_windows</span>
                    <span className="text-xs font-bold text-slate-200">Segundo Plano & Bandeja del Sistema</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleHideToTray}
                    className="px-2.5 py-1 rounded-lg bg-purple-950/50 hover:bg-purple-900/60 border border-purple-500/30 text-purple-300 text-[11px] flex items-center gap-1.5 transition-colors"
                    title="Minimiza la ventana a la bandeja del sistema"
                  >
                    <span className="material-symbols-outlined text-[13px]">visibility_off</span>
                    <span>Minimizar a Bandeja</span>
                  </button>
                </div>

                <div className="space-y-2 pt-1 border-t border-slate-800/80">
                  <label className="flex items-center justify-between cursor-pointer group">
                    <div className="pr-4">
                      <div className="text-xs text-slate-300 font-medium group-hover:text-purple-300 transition-colors">
                        Ejecutar en segundo plano al cerrar
                      </div>
                      <div className="text-[10px] text-slate-400">
                        Al cerrar la ventana (X), se oculta a la bandeja del sistema. El servidor HTTP y MCP continúan 24/7.
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={runInBackground}
                      onChange={handleToggleRunInBackground}
                      className="w-4 h-4 accent-purple-500 rounded bg-slate-900 border-slate-700 cursor-pointer"
                    />
                  </label>

                  <label className="flex items-center justify-between cursor-pointer group">
                    <div className="pr-4">
                      <div className="text-xs text-slate-300 font-medium group-hover:text-purple-300 transition-colors">
                        Iniciar automáticamente con Windows
                      </div>
                      <div className="text-[10px] text-slate-400">
                        Inicia el servicio en segundo plano al encender el equipo.
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={openAtLogin}
                      onChange={handleToggleOpenAtLogin}
                      className="w-4 h-4 accent-purple-500 rounded bg-slate-900 border-slate-700 cursor-pointer"
                    />
                  </label>
                </div>
              </div>

              {/* Mensajes de Resultado de Prueba o Guardado */}
              {testEmbedStatus && (
                <div
                  className={`p-2.5 rounded-xl text-xs flex items-center justify-between gap-2 ${
                    testEmbedStatus === 'testing'
                      ? 'bg-purple-950/40 border border-purple-500/30 text-purple-300 animate-pulse'
                      : testEmbedStatus.ok
                      ? 'bg-emerald-950/60 border border-emerald-500/40 text-emerald-300'
                      : 'bg-rose-950/60 border border-rose-500/40 text-rose-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[16px]">
                      {testEmbedStatus === 'testing'
                        ? 'hourglass_empty'
                        : testEmbedStatus.ok
                        ? 'check_circle'
                        : 'error'}
                    </span>
                    <span>
                      {testEmbedStatus === 'testing'
                        ? 'Ejecutando inferencia de prueba...'
                        : testEmbedStatus.ok
                        ? `Inferencia exitosa (${testEmbedStatus.provider}, ${testEmbedStatus.dimension ? testEmbedStatus.dimension + 'D, ' : ''}${testEmbedStatus.timeMs}ms)`
                        : `Error: ${testEmbedStatus.error}`}
                    </span>
                  </div>
                </div>
              )}

              {settingsSaveMsg && (
                <div
                  className={`p-2.5 rounded-xl text-xs font-semibold text-center ${
                    settingsSaveMsg.includes('Error')
                      ? 'bg-rose-950/70 border border-rose-500/40 text-rose-300'
                      : 'bg-emerald-950/70 border border-emerald-500/40 text-emerald-300'
                  }`}
                >
                  {settingsSaveMsg}
                </div>
              )}
            </div>

            {/* Footer con Acciones */}
            <div className="flex items-center justify-between pt-3 border-t border-slate-800 gap-2">
              <button
                type="button"
                onClick={handleTestEmbedding}
                disabled={testEmbedStatus === 'testing'}
                className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-slate-100 text-xs flex items-center gap-1.5 transition-colors"
              >
                <span className="material-symbols-outlined text-[14px] text-purple-400">science</span>
                <span>Probar</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowSettingsModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs transition-colors"
                >
                  Cerrar
                </button>
                <button
                  type="button"
                  onClick={handleSaveSettings}
                  disabled={settingsSaving}
                  className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow-[0_0_15px_rgba(168,85,247,0.35)] transition-all"
                >
                  <span className="material-symbols-outlined text-[14px]">
                    {settingsSaving ? 'sync' : 'save'}
                  </span>
                  <span>{settingsSaving ? 'Guardando...' : 'Guardar'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
