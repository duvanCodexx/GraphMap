#!/usr/bin/env node
/**
 * EMBEDING-ELECTRON MCP Server
 * Protocol: Model Context Protocol (MCP) JSON-RPC 2.0 over stdio
 * Permite a agentes de IA (Claude Code, Antigravity, Cursor, etc.) buscar código,
 * guardar memoria contextual para ahorrar tokens y reindexar archivos modificados en tiempo real.
 */

const readline = require('node:readline')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { URL } = require('node:url')

const CANDIDATE_PORTS = [8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010]
let cachedServerUrl = process.env.EMBEDING_SERVER_URL || null
let clientName = 'Agente IA'

function log(...args) {
  process.stderr.write(`[embeding-mcp] ${args.join(' ')}\n`)
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } })
}

function getElectronServerInfo() {
  const possiblePaths = []
  if (process.platform === 'win32' && process.env.APPDATA) {
    possiblePaths.push(path.join(process.env.APPDATA, 'GraphMap', 'server-info.json'))
    possiblePaths.push(path.join(process.env.APPDATA, 'graphmap', 'server-info.json'))
    possiblePaths.push(path.join(process.env.APPDATA, 'EMBEDING-ELECTRON', 'server-info.json'))
  } else if (process.platform === 'darwin') {
    possiblePaths.push(path.join(os.homedir(), 'Library', 'Application Support', 'GraphMap', 'server-info.json'))
  } else {
    possiblePaths.push(path.join(os.homedir(), '.config', 'GraphMap', 'server-info.json'))
  }

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8')
        const data = JSON.parse(raw)
        if (data && data.url) return data.url
      }
    } catch {}
  }
  return null
}

function probeHealth(targetUrl, timeoutMs = 600) {
  return new Promise((resolve) => {
    try {
      const u = new URL('/health', targetUrl)
      const req = http.request(
        u,
        {
          method: 'GET',
          timeout: timeoutMs,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        },
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    } catch {
      resolve(false)
    }
  })
}

async function resolveServerUrl() {
  // 1. Si ya tenemos una URL cacheada y responde, usarla
  if (cachedServerUrl && (await probeHealth(cachedServerUrl, 400))) {
    return cachedServerUrl
  }

  // 2. Si la variable de entorno está definida, verificarla
  if (process.env.EMBEDING_SERVER_URL) {
    if (await probeHealth(process.env.EMBEDING_SERVER_URL, 600)) {
      cachedServerUrl = process.env.EMBEDING_SERVER_URL
      return cachedServerUrl
    }
  }

  // 3. Revisar server-info.json guardado por GraphMap
  const infoUrl = getElectronServerInfo()
  if (infoUrl && (await probeHealth(infoUrl, 600))) {
    cachedServerUrl = infoUrl
    return cachedServerUrl
  }

  // 4. Sondeo automático en el rango de puertos auxiliares (8001-8010)
  for (const port of CANDIDATE_PORTS) {
    const candidateUrl = `http://127.0.0.1:${port}`
    if (await probeHealth(candidateUrl, 400)) {
      cachedServerUrl = candidateUrl
      log(`Conectado exitosamente con backend en puerto auxiliar ${port}`)
      return cachedServerUrl
    }
  }

  return cachedServerUrl || 'http://127.0.0.1:8001'
}

async function requestBackend(method, endpoint, body, allowRetry = true) {
  const currentBaseUrl = await resolveServerUrl()
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(endpoint, currentBaseUrl)
    } catch (e) {
      return reject(new Error(`URL inválida: ${endpoint} en base ${currentBaseUrl}`))
    }

    const payload = body ? JSON.stringify(body) : null
    const req = http.request(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: Number(process.env.MCP_TIMEOUT_MS) || 60000,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            resolve({ status: res.statusCode, data: parsed })
          } catch {
            resolve({ status: res.statusCode, text: data })
          }
        })
      },
    )

    req.on('error', async (err) => {
      if (allowRetry) {
        cachedServerUrl = null
        try {
          const retried = await requestBackend(method, endpoint, body, false)
          return resolve(retried)
        } catch {}
      }
      reject(
        new Error(
          `No se pudo conectar con el backend de GraphMap en ${currentBaseUrl} (se sondearon puertos 8001-8010). Asegúrate de que GraphMap esté ejecutándose. Detalle: ${err.message}`,
        ),
      )
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Timeout al conectar con el backend en ${currentBaseUrl}`))
    })

    if (payload) req.write(payload)
    req.end()
  })
}

function getEffectiveProjectPath(args) {
  if (args && typeof args.project_path === 'string' && args.project_path.trim()) {
    return args.project_path.trim()
  }
  if (process.env.EMBEDING_PROJECT_PATH && process.env.EMBEDING_PROJECT_PATH.trim()) {
    return process.env.EMBEDING_PROJECT_PATH.trim()
  }
  return process.cwd()
}

const TOOLS = [
  {
    name: 'search_code',
    description:
      'Busca funciones, clases, componentes y fragmentos semánticos en el código del proyecto. Retorna contexto funcional estructurado con archivo y números de línea sin necesidad de leer archivos completos en el prompt, ahorrando tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Consulta de búsqueda o concepto (ej: "derivada de funcion de activacion", "handleRequest", "Neuron class").',
        },
        top_k: {
          type: 'number',
          description: 'Número máximo de fragmentos a recuperar (por defecto 5, máx 20).',
        },
        project_path: {
          type: 'string',
          description: 'Ruta absoluta o relativa del proyecto/repositorio a consultar. Por defecto utiliza el directorio actual de trabajo.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'store_memory',
    description:
      'Guarda una nota, resumen de archivo o decisión arquitectónica en la memoria persistente del proyecto. Evita releer archivos completos en futuras tareas y ahorra tokens masivamente.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Identificador único o tema de la memoria (ej: "patron_red_neuronal", "resumen:SimpleNeuron.php").',
        },
        content: {
          type: 'string',
          description: 'Contenido condensado, interfaz pública, resumen o regla a recordar.',
        },
        summary: {
          type: 'string',
          description: 'Breve descripción de una línea de esta memoria.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Etiquetas temáticas (ej: ["php", "arquitectura", "neuronas"]).',
        },
        file_path: {
          type: 'string',
          description: 'Ruta del archivo asociado si aplica.',
        },
        project_path: {
          type: 'string',
          description: 'Ruta del proyecto al que asociar esta memoria. Por defecto el directorio actual de trabajo.',
        },
      },
      required: ['key', 'content'],
    },
  },
  {
    name: 'recall_memory',
    description:
      'Recupera notas, resúmenes de archivos y contexto guardado en memoria por similitud semántica o clave, reduciendo el consumo de tokens en tus respuestas.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Consulta o tema a recordar (ej: "cómo funciona la propagación hacia adelante", "interfaz neuron").',
        },
        limit: {
          type: 'number',
          description: 'Máximo número de memorias a retornar (por defecto 5).',
        },
        project_path: {
          type: 'string',
          description: 'Ruta del proyecto desde el cual buscar memorias. Por defecto el directorio actual de trabajo.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_memories',
    description: 'Lista todas las claves y resúmenes de memoria almacenados actualmente para el proyecto.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Ruta del proyecto a listar. Por defecto el directorio actual de trabajo.',
        },
      },
    },
  },
  {
    name: 'reindex_file',
    description:
      'Reindexa inmediatamente un archivo individual modificado en la base vectorial para que los cambios estén disponibles al instante en las búsquedas sin reindexar todo el proyecto.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Ruta relativa o absoluta del archivo que fue modificado o creado.',
        },
        project_path: {
          type: 'string',
          description: 'Ruta raíz del proyecto si file_path es relativo.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'reindex_project',
    description: 'Inicia la reindexación completa de todos los archivos del proyecto en segundo plano.',
    inputSchema: {
      type: 'object',
      properties: {
        confirmar: {
          type: 'boolean',
          description: 'Confirmación para iniciar la reindexación.',
        },
        project_path: {
          type: 'string',
          description: 'Ruta del proyecto a reindexar. Por defecto el directorio actual de trabajo.',
        },
      },
    },
  },
  {
    name: 'get_stats',
    description: 'Obtiene estadísticas de la base vectorial, memoria persistente y tokens ahorrados para un proyecto.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Ruta del proyecto del cual obtener estadísticas.',
        },
      },
    },
  },
  {
    name: 'list_projects',
    description: 'Lista todas las bases de datos / proyectos registrados en Embeding Electron con sus métricas y proyecto activo.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_active_project',
    description: 'Establece o registra el proyecto activo en Embeding Electron usando su ruta en disco o ID.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Ruta del directorio del proyecto (ej: "C:/mis-proyectos/app") o ID del proyecto (ej: "p_app_1234").',
        },
      },
      required: ['project'],
    },
  },
]

async function handleToolCall(name, args) {
  if (name === 'search_code') {
    const q = String(args?.query || '').trim()
    const topK = typeof args?.top_k === 'number' ? args.top_k : 5
    const projectPath = getEffectiveProjectPath(args)
    const resp = await requestBackend('POST', '/agent/search', {
      query: q,
      top_k: topK,
      agent_name: clientName,
      project_path: projectPath,
    })

    if (resp.status !== 200) {
      return { isError: true, text: `Error del servidor (${resp.status}): ${JSON.stringify(resp.data || resp.text)}` }
    }

    const chunks = resp.data?.chunks || []
    const projName = resp.data?.project?.name || 'Proyecto'
    if (!chunks.length) {
      return { text: `[${projName}] No se encontraron fragmentos relevantes para "${q}". ${resp.data?.warning || ''}` }
    }

    const formatted = chunks
      .map((c, idx) => {
        const badge = c.tipo ? `[${c.tipo.toUpperCase()}${c.nombre ? `: ${c.nombre}` : ''}] ` : ''
        const lines = c.linea_inicio != null ? ` (L${c.linea_inicio}-L${c.linea_fin ?? '?'})` : ''
        const header = `### Fragmento ${idx + 1}: ${badge}${c.archivo}${lines} | Relevancia: ${Math.round(c.relevancia * 100)}%`
        const scope = c.scope ? `Scope: ${c.scope}\n` : ''
        const code = c.codigo_puro || c.contenido
        return `${header}\n${scope}\`\`\`\n${code}\n\`\`\``
      })
      .join('\n\n')

    return { text: `[${projName}] Encontrados ${chunks.length} fragmentos para "${q}":\n\n${formatted}` }
  }

  if (name === 'store_memory') {
    const projectPath = getEffectiveProjectPath(args)
    const resp = await requestBackend('POST', '/agent/memory', {
      key: args?.key,
      content: args?.content,
      summary: args?.summary,
      tags: args?.tags,
      file_path: args?.file_path,
      project_path: projectPath,
      agent_name: clientName,
    })

    if (resp.status !== 200) {
      return { isError: true, text: `Error guardando memoria: ${JSON.stringify(resp.data || resp.text)}` }
    }

    const mem = resp.data?.memory
    const projName = resp.data?.project?.name || 'Proyecto'
    return {
      text: `✓ [${projName}] Memoria guardada exitosamente con clave "${mem?.key}". Tokens estimados ahorrados por consulta: ~${mem?.tokensEstimated || 0} tokens.`,
    }
  }

  if (name === 'recall_memory') {
    const q = String(args?.query || '').trim()
    const limit = typeof args?.limit === 'number' ? args.limit : 5
    const projectPath = getEffectiveProjectPath(args)
    const endpoint = `/agent/memory?q=${encodeURIComponent(q)}&limit=${limit}&agent_name=${encodeURIComponent(clientName)}&project_path=${encodeURIComponent(projectPath)}`
    const resp = await requestBackend('GET', endpoint)

    if (resp.status !== 200) {
      return { isError: true, text: `Error recuperando memorias: ${JSON.stringify(resp.data || resp.text)}` }
    }

    const memories = resp.data?.memories || []
    const projName = resp.data?.project?.name || 'Proyecto'
    if (!memories.length) {
      return { text: `[${projName}] No se encontraron memorias previas para "${q}".` }
    }

    const textParts = memories.map((m, idx) => {
      const tags = m.tags && m.tags.length ? ` [tags: ${m.tags.join(', ')}]` : ''
      const file = m.filePath ? ` (archivo: ${m.filePath})` : ''
      return `### Memoria ${idx + 1}: ${m.key}${tags}${file}\n${m.content}`
    })

    return {
      text: `[${projName}] Recuperadas ${memories.length} memorias relevantes (~${resp.data?.tokensSavedNow || 0} tokens ahorrados):\n\n${textParts.join('\n\n')}`,
    }
  }

  if (name === 'list_memories') {
    const projectPath = getEffectiveProjectPath(args)
    const endpoint = `/agent/memory?agent_name=${encodeURIComponent(clientName)}&project_path=${encodeURIComponent(projectPath)}`
    const resp = await requestBackend('GET', endpoint)
    if (resp.status !== 200) {
      return { isError: true, text: `Error listando memorias: ${JSON.stringify(resp.data || resp.text)}` }
    }

    const memories = resp.data?.memories || []
    const stats = resp.data?.stats || {}
    const projName = resp.data?.project?.name || 'Proyecto'
    if (!memories.length) {
      return { text: `[${projName}] La memoria persistente está vacía. Usa "store_memory" para guardar resúmenes y decisiones.` }
    }

    const list = memories
      .map((m, i) => `${i + 1}. **${m.key}** - ${m.summary || m.content.slice(0, 80)} (usado ${m.accessCount} veces)`)
      .join('\n')

    return {
      text: `[${projName}] Memorias almacenadas (${memories.length} total | ${stats.totalTokensSaved || 0} tokens acumulados ahorrados):\n\n${list}`,
    }
  }

  if (name === 'reindex_file') {
    const filePath = String(args?.file_path || '').trim()
    const projectPath = getEffectiveProjectPath(args)
    const resp = await requestBackend('POST', '/agent/reindex-file', {
      file_path: filePath,
      project_path: projectPath,
      agent_name: clientName,
    })

    if (resp.status !== 200) {
      return { isError: true, text: `Error reindexando archivo: ${JSON.stringify(resp.data || resp.text)}` }
    }

    const projName = resp.data?.project?.name || 'Proyecto'
    return {
      text: `✓ [${projName}] Archivo "${filePath}" reindexado con éxito en la base vectorial (${resp.data?.chunksCount || 0} fragmentos generados).`,
    }
  }

  if (name === 'reindex_project') {
    const projectPath = getEffectiveProjectPath(args)
    const resp = await requestBackend('POST', '/reindexar', { confirmar: true, project: projectPath })
    if (resp.status !== 200) {
      return { isError: true, text: `Error al iniciar reindexación: ${JSON.stringify(resp.data || resp.text)}` }
    }
    const projName = resp.data?.project?.name || 'Proyecto'
    return {
      text: `✓ [${projName}] Reindexación iniciada en segundo plano (Job ID: ${resp.data?.job_id || 'ok'}). Puedes monitorearlo en la interfaz de usuario.`,
    }
  }

  if (name === 'get_stats') {
    const projectPath = getEffectiveProjectPath(args)
    const [statsResp, memResp] = await Promise.all([
      requestBackend('GET', `/stats?project=${encodeURIComponent(projectPath)}`).catch(() => ({ data: null })),
      requestBackend('GET', `/agent/memory?project_path=${encodeURIComponent(projectPath)}`).catch(() => ({ data: null })),
    ])

    const s = statsResp.data || {}
    const m = memResp.data?.stats || {}
    const p = statsResp.data?.project || {}

    return {
      text:
        `📊 Estadísticas de Base de Datos [${p.name || s.project_dir || 'Proyecto'}]:\n` +
        `- ID Proyecto: ${p.id || 'N/A'}\n` +
        `- Directorio: ${p.path || s.project_dir || '(no configurado)'}\n` +
        `- Chunks vectoriales indexados: ${s.total_chunks || 0}\n` +
        `- Archivos únicos en índice: ${s.unique_files || 0}\n` +
        `- Tabla vectorial LanceDB: ${p.tableName || 'N/A'}\n` +
        `- Proveedor de embeddings: ${s.embedding_provider || 'local'}\n` +
        `- Memorias persistentes del proyecto: ${m.totalMemories || 0}\n` +
        `- Tokens acumulados ahorrados: ~${m.totalTokensSaved || 0} tokens`,
    }
  }

  if (name === 'list_projects') {
    const resp = await requestBackend('GET', '/projects')
    if (resp.status !== 200) {
      return { isError: true, text: `Error consultando proyectos: ${JSON.stringify(resp.data || resp.text)}` }
    }
    const projects = resp.data?.projects || []
    const active = resp.data?.activeProject
    if (!projects.length) {
      return { text: 'No hay proyectos registrados en el servidor de Embeding Electron.' }
    }

    const lines = projects.map((p, idx) => {
      const isActive = active && active.id === p.id ? ' ⭐ [ACTIVO]' : ''
      return `${idx + 1}.${isActive} **${p.name}** (\`${p.id}\`)\n   - Ruta: \`${p.path}\`\n   - Chunks: ${p.totalChunks ?? 0} | Archivos: ${p.uniqueFiles ?? 0} | Tabla: \`${p.tableName}\``
    })

    return {
      text: `📂 Bases de datos / Proyectos disponibles (${projects.length}):\n\n${lines.join('\n\n')}`,
    }
  }

  if (name === 'set_active_project') {
    const target = String(args?.project || '').trim()
    if (!target) return { isError: true, text: 'Falta parámetro "project" (ruta o ID).' }

    // Si parece una ruta con slashes o backslashes
    const isPath = target.includes('/') || target.includes('\\') || target.includes(':')
    let resp
    if (isPath) {
      resp = await requestBackend('POST', '/projects', { path: target })
    } else {
      resp = await requestBackend('POST', '/projects/active', { id: target })
    }

    if (resp.status !== 200) {
      return { isError: true, text: `Error activando proyecto: ${JSON.stringify(resp.data || resp.text)}` }
    }

    const p = resp.data?.project
    return {
      text: `✓ Proyecto activo cambiado a "${p?.name}" (\`${p?.id}\`) en \`${p?.path}\`.`,
    }
  }

  throw new Error(`Herramienta desconocida: "${name}"`)
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return

  const { id, method, params } = msg

  // Manejo de Initialize
  if (method === 'initialize') {
    if (params?.clientInfo?.name) {
      clientName = `${params.clientInfo.name}${params.clientInfo.version ? ` v${params.clientInfo.version}` : ''}`
    }
    log(`Cliente conectado: ${clientName}`)
    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'embeding-electron',
        version: '1.1.0',
      },
    })
    return
  }

  // Notificaciones sin ID
  if (method === 'notifications/initialized') {
    log('Sesión inicializada correctamente')
    return
  }

  if (method === 'ping') {
    sendResult(id, {})
    return
  }

  // Listar herramientas
  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS })
    return
  }

  // Ejecutar herramienta
  if (method === 'tools/call') {
    const toolName = params?.name
    const toolArgs = params?.arguments || {}
    log(`Llamada a herramienta: ${toolName} con argumentos: ${JSON.stringify(toolArgs)}`)

    try {
      const res = await handleToolCall(toolName, toolArgs)
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: res.text,
          },
        ],
        isError: Boolean(res.isError),
      })
    } catch (err) {
      log(`Error ejecutando herramienta ${toolName}: ${err.message}`)
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: `Error ejecutando ${toolName}: ${err.message}`,
          },
        ],
        isError: true,
      })
    }
    return
  }

  // Método no implementado
  if (id != null) {
    sendError(id, -32601, `Método no implementado: ${method}`)
  }
}

// Iniciar lectura de líneas por stdin
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
})

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const msg = JSON.parse(trimmed)
    handleMessage(msg).catch((err) => {
      log(`Error procesando mensaje: ${err.message}`)
    })
  } catch (err) {
    log(`JSON inválido recibido: ${trimmed}`)
  }
})

rl.on('close', () => {
  log('Conexión stdin cerrada, finalizando servidor MCP')
  process.exit(0)
})

log(`Servidor MCP iniciado y listo en stdio (Detección automática en puertos auxiliares 8001-8010)`)
