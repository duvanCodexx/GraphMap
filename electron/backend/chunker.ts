import * as path from 'node:path'
import * as ts from 'typescript'

export type ChunkType =
  | 'function'
  | 'method'
  | 'class'
  | 'component'
  | 'hook'
  | 'interface'
  | 'type'
  | 'section'
  | 'module'
  | 'block'

export type CodeChunk = {
  texto: string
  codigo_puro: string
  archivo: string
  linea_inicio: number
  linea_fin: number
  tipo: ChunkType
  nombre: string
  scope: string
  firma?: string
  lenguaje: string
}

export type ChunkerOptions = {
  maxChars?: number
  overlapLines?: number
}

const DEFAULT_MAX_CHARS = 1600
const DEFAULT_OVERLAP_LINES = 6

function commentPrefix(language: string): { line: string; open?: string; close?: string } {
  const lang = (language || '').toLowerCase()
  if (['python', 'bash', 'yaml', 'powershell', 'dockerfile'].includes(lang)) {
    return { line: '#' }
  }
  if (['html', 'xml'].includes(lang)) {
    return { line: '<!--', open: '<!--', close: '-->' }
  }
  if (['sql'].includes(lang)) {
    return { line: '--' }
  }
  return { line: '//' }
}

function buildEnrichedText(
  archivo: string,
  codigoPuro: string,
  tipo: ChunkType,
  nombre: string,
  scope: string,
  lineaInicio: number,
  lineaFin: number,
  language: string,
  extraContext?: string,
): string {
  const { line: cp } = commentPrefix(language)
  const headerLines = [
    `${cp} ============================================================`,
    `${cp} Archivo: ${archivo}`,
    `${cp} Simbolo: [${tipo.toUpperCase()}] ${nombre || '(bloque)'}`,
    `${cp} Scope: ${scope || archivo}`,
    `${cp} Lineas: L${lineaInicio}-L${lineaFin}`,
  ]

  if (extraContext && extraContext.trim()) {
    headerLines.push(`${cp} Contexto: ${extraContext.trim()}`)
  }

  headerLines.push(`${cp} ============================================================`)

  return `${headerLines.join('\n')}\n${codigoPuro}`
}

export function detectLanguage(rutaRel: string): string {
  const ext = path.extname(rutaRel).toLowerCase()
  if (ext === '.py') return 'python'
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'typescript'
  if (ext === '.tsx') return 'typescript'
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript'
  if (ext === '.jsx') return 'javascript'
  if (ext === '.php') return 'php'
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (ext === '.json') return 'json'
  if (ext === '.yml' || ext === '.yaml') return 'yaml'
  if (ext === '.sh' || ext === '.bash') return 'bash'
  if (ext === '.ps1') return 'powershell'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.css' || ext === '.scss' || ext === '.less') return 'css'
  if (ext === '.sql') return 'sql'
  return 'text'
}

// -------------------------------------------------------------
// AST Chunking para TypeScript / JavaScript (TS, TSX, JS, JSX)
// -------------------------------------------------------------
function isReactComponent(name: string, nodeText: string): boolean {
  if (!name || name.length === 0) return false
  const first = name[0]
  if (first !== first?.toUpperCase() || !/[A-Za-z]/.test(first)) return false
  return /<[A-Z][A-Za-z0-9]*|<[a-z]+|\breturn\s*\(?\s*<|jsx|useState|useEffect|useMemo|useCallback/.test(nodeText)
}

function isReactHook(name: string): boolean {
  return /^use[A-Z0-9]/.test(name)
}

function getNodeSignature(sf: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(sf)
  const openBrace = text.indexOf('{')
  if (openBrace !== -1) {
    return text.slice(0, openBrace).trim()
  }
  const firstLine = text.split('\n')[0] || ''
  return firstLine.slice(0, 120).trim()
}

function splitLargeTextByStatements(
  sf: ts.SourceFile,
  statements: ts.NodeArray<ts.Statement> | ts.Node[],
  archivo: string,
  parentType: ChunkType,
  parentName: string,
  parentScope: string,
  maxChars: number,
  language: string,
): CodeChunk[] {
  const chunks: CodeChunk[] = []
  let batchNodes: ts.Node[] = []
  let batchChars = 0

  const flushBatch = () => {
    if (!batchNodes.length) return
    const firstNode = batchNodes[0]!
    const lastNode = batchNodes[batchNodes.length - 1]!

    const startPos = sf.getLineAndCharacterOfPosition(firstNode.getStart(sf))
    const endPos = sf.getLineAndCharacterOfPosition(lastNode.getEnd())
    const lineaInicio = startPos.line + 1
    const lineaFin = endPos.line + 1

    const rawCode = sf.text.slice(firstNode.getStart(sf), lastNode.getEnd()).trim()
    if (rawCode.length > 0) {
      const scope = `${parentScope} > L${lineaInicio}-L${lineaFin}`
      const enriched = buildEnrichedText(
        archivo,
        rawCode,
        parentType,
        parentName,
        scope,
        lineaInicio,
        lineaFin,
        language,
        `Fragmento de ${parentType} '${parentName}'`,
      )

      chunks.push({
        texto: enriched,
        codigo_puro: rawCode,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo: parentType,
        nombre: parentName,
        scope,
        lenguaje: language,
      })
    }

    batchNodes = []
    batchChars = 0
  }

  for (const st of statements) {
    const text = st.getText(sf)
    const len = text.length

    // Si es una función anidada o hook importante dentro de una función grande:
    let innerName = ''
    let isInnerFunc = false
    if (ts.isFunctionDeclaration(st)) {
      innerName = st.name?.text || ''
      isInnerFunc = true
    } else if (ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations[0]
      if (d && d.name && (ts.isIdentifier(d.name) || ts.isStringLiteral(d.name))) {
        const declName = d.name.getText(sf)
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer) || ts.isCallExpression(d.initializer))) {
          innerName = declName
          isInnerFunc = true
        }
      }
    }

    if (isInnerFunc && innerName && len <= maxChars * 1.5) {
      flushBatch()
      const startPos = sf.getLineAndCharacterOfPosition(st.getStart(sf))
      const endPos = sf.getLineAndCharacterOfPosition(st.getEnd())
      const lineaInicio = startPos.line + 1
      const lineaFin = endPos.line + 1
      const subType = isReactHook(innerName) ? 'hook' : isReactComponent(innerName, text) ? 'component' : 'function'
      const scope = `${parentScope} > ${innerName}`
      const enriched = buildEnrichedText(
        archivo,
        text,
        subType,
        innerName,
        scope,
        lineaInicio,
        lineaFin,
        language,
        `Miembro interno de ${parentName}`,
      )
      chunks.push({
        texto: enriched,
        codigo_puro: text,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo: subType,
        nombre: innerName,
        scope,
        lenguaje: language,
      })
      continue
    }

    if (batchChars + len > maxChars && batchNodes.length > 0) {
      flushBatch()
    }

    batchNodes.push(st)
    batchChars += len
  }

  flushBatch()
  return chunks
}

function chunkTypeScriptAst(archivo: string, content: string, maxChars: number, language: string): CodeChunk[] {
  const ext = path.extname(archivo).toLowerCase()
  let scriptKind = ts.ScriptKind.TS
  if (ext === '.tsx') scriptKind = ts.ScriptKind.TSX
  else if (ext === '.jsx') scriptKind = ts.ScriptKind.JSX
  else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') scriptKind = ts.ScriptKind.JS

  const sf = ts.createSourceFile(archivo, content, ts.ScriptTarget.Latest, true, scriptKind)
  const chunks: CodeChunk[] = []

  let unbundledStatements: ts.Statement[] = []
  let unbundledChars = 0

  const flushUnbundled = () => {
    if (!unbundledStatements.length) return
    const first = unbundledStatements[0]!
    const last = unbundledStatements[unbundledStatements.length - 1]!

    const startPos = sf.getLineAndCharacterOfPosition(first.getStart(sf))
    const endPos = sf.getLineAndCharacterOfPosition(last.getEnd())
    const lineaInicio = startPos.line + 1
    const lineaFin = endPos.line + 1

    const rawCode = sf.text.slice(first.getStart(sf), last.getEnd()).trim()
    if (rawCode.length > 20) {
      const scope = `${archivo} > modulo (L${lineaInicio}-L${lineaFin})`
      const enriched = buildEnrichedText(
        archivo,
        rawCode,
        'module',
        'modulo/imports/config',
        scope,
        lineaInicio,
        lineaFin,
        language,
      )

      chunks.push({
        texto: enriched,
        codigo_puro: rawCode,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo: 'module',
        nombre: 'modulo/imports',
        scope,
        lenguaje: language,
      })
    }

    unbundledStatements = []
    unbundledChars = 0
  }

  for (const st of sf.statements) {
    const rawText = st.getText(sf)
    const len = rawText.length
    const startPos = sf.getLineAndCharacterOfPosition(st.getStart(sf))
    const endPos = sf.getLineAndCharacterOfPosition(st.getEnd())
    const lineaInicio = startPos.line + 1
    const lineaFin = endPos.line + 1

    // 1. Declaración de Función
    if (ts.isFunctionDeclaration(st)) {
      flushUnbundled()
      const name = st.name?.text || '(anónima)'
      const isComp = isReactComponent(name, rawText)
      const isHk = isReactHook(name)
      const tipo: ChunkType = isComp ? 'component' : isHk ? 'hook' : 'function'
      const scope = `${archivo} > ${name}()`
      const firma = getNodeSignature(sf, st)

      if (len <= maxChars * 1.6 || !st.body) {
        // Cabe entero
        const enriched = buildEnrichedText(archivo, rawText, tipo, name, scope, lineaInicio, lineaFin, language, firma)
        chunks.push({
          texto: enriched,
          codigo_puro: rawText,
          archivo,
          linea_inicio: lineaInicio,
          linea_fin: lineaFin,
          tipo,
          nombre: name,
          scope,
          firma,
          lenguaje: language,
        })
      } else {
        // Función grande: dividir internamente por sentencias
        const sub = splitLargeTextByStatements(
          sf,
          st.body.statements,
          archivo,
          tipo,
          name,
          scope,
          maxChars,
          language,
        )
        chunks.push(...sub)
      }
      continue
    }

    // 2. Declaración de Clase
    if (ts.isClassDeclaration(st)) {
      flushUnbundled()
      const className = st.name?.text || '(clase anónima)'
      const classScope = `${archivo} > class ${className}`
      const firma = getNodeSignature(sf, st)

      if (len <= maxChars * 1.5) {
        const enriched = buildEnrichedText(archivo, rawText, 'class', className, classScope, lineaInicio, lineaFin, language, firma)
        chunks.push({
          texto: enriched,
          codigo_puro: rawText,
          archivo,
          linea_inicio: lineaInicio,
          linea_fin: lineaFin,
          tipo: 'class',
          nombre: className,
          scope: classScope,
          firma,
          lenguaje: language,
        })
      } else {
        // Desglosar por métodos miembros
        for (const member of st.members) {
          const mText = member.getText(sf)
          const mStart = sf.getLineAndCharacterOfPosition(member.getStart(sf))
          const mEnd = sf.getLineAndCharacterOfPosition(member.getEnd())
          const mLineaInicio = mStart.line + 1
          const mLineaFin = mEnd.line + 1

          let mName = '(miembro)'
          if (member.name) mName = member.name.getText(sf)
          else if (ts.isConstructorDeclaration(member)) mName = 'constructor'

          const mScope = `${classScope} > ${mName}`
          const mFirma = getNodeSignature(sf, member)
          const enriched = buildEnrichedText(
            archivo,
            mText,
            'method',
            `${className}.${mName}`,
            mScope,
            mLineaInicio,
            mLineaFin,
            language,
            `Metodo de clase ${className}: ${mFirma}`,
          )

          chunks.push({
            texto: enriched,
            codigo_puro: mText,
            archivo,
            linea_inicio: mLineaInicio,
            linea_fin: mLineaFin,
            tipo: 'method',
            nombre: `${className}.${mName}`,
            scope: mScope,
            firma: mFirma,
            lenguaje: language,
          })
        }
      }
      continue
    }

    // 3. Declaración de Variables (const Button = () => ..., const api = { ... })
    if (ts.isVariableStatement(st)) {
      const decl = st.declarationList.declarations[0]
      if (decl && decl.name) {
        const varName = decl.name.getText(sf)
        const init = decl.initializer

        const isFunc = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        const isComp = isFunc && isReactComponent(varName, rawText)
        const isHk = isFunc && isReactHook(varName)

        if (isFunc || isComp || isHk) {
          flushUnbundled()
          const tipo: ChunkType = isComp ? 'component' : isHk ? 'hook' : 'function'
          const scope = `${archivo} > const ${varName}`
          const firma = getNodeSignature(sf, st)

          if (len <= maxChars * 1.6 || !init || !('body' in init) || !init.body || !('statements' in (init.body as any))) {
            const enriched = buildEnrichedText(archivo, rawText, tipo, varName, scope, lineaInicio, lineaFin, language, firma)
            chunks.push({
              texto: enriched,
              codigo_puro: rawText,
              archivo,
              linea_inicio: lineaInicio,
              linea_fin: lineaFin,
              tipo,
              nombre: varName,
              scope,
              firma,
              lenguaje: language,
            })
          } else {
            const bodyStmts = (init.body as ts.Block).statements
            const sub = splitLargeTextByStatements(sf, bodyStmts, archivo, tipo, varName, scope, maxChars, language)
            chunks.push(...sub)
          }
          continue
        }
      }
    }

    // 4. Interfaces y Tipos
    if (ts.isInterfaceDeclaration(st)) {
      flushUnbundled()
      const ifaceName = st.name.text
      const scope = `${archivo} > interface ${ifaceName}`
      const enriched = buildEnrichedText(archivo, rawText, 'interface', ifaceName, scope, lineaInicio, lineaFin, language)
      chunks.push({
        texto: enriched,
        codigo_puro: rawText,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo: 'interface',
        nombre: ifaceName,
        scope,
        lenguaje: language,
      })
      continue
    }

    if (ts.isTypeAliasDeclaration(st)) {
      flushUnbundled()
      const typeName = st.name.text
      const scope = `${archivo} > type ${typeName}`
      const enriched = buildEnrichedText(archivo, rawText, 'type', typeName, scope, lineaInicio, lineaFin, language)
      chunks.push({
        texto: enriched,
        codigo_puro: rawText,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo: 'type',
        nombre: typeName,
        scope,
        lenguaje: language,
      })
      continue
    }

    // Acumular sentencias menores de módulo/imports/constantes
    if (unbundledChars + len > maxChars && unbundledStatements.length > 0) {
      flushUnbundled()
    }
    unbundledStatements.push(st)
    unbundledChars += len
  }

  flushUnbundled()
  return chunks
}

// -------------------------------------------------------------
// AST / Indent Chunking para Python (.py)
// -------------------------------------------------------------
function chunkPython(archivo: string, content: string, maxChars: number, language: string): CodeChunk[] {
  const lines = content.split('\n')
  const chunks: CodeChunk[] = []

  let i = 0
  let moduleLines: string[] = []
  let moduleStart = 1

  const flushModule = () => {
    if (!moduleLines.length) return
    const raw = moduleLines.join('\n').trim()
    if (raw.length > 20) {
      const lineaInicio = moduleStart
      const lineaFin = moduleStart + moduleLines.length - 1
      const scope = `${archivo} > modulo (L${lineaInicio}-L${lineaFin})`
      const enriched = buildEnrichedText(archivo, raw, 'module', 'modulo/imports', scope, lineaInicio, lineaFin, language)
      chunks.push({
        texto: enriched,
        codigo_puro: raw,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo: 'module',
        nombre: 'modulo/imports',
        scope,
        lenguaje: language,
      })
    }
    moduleLines = []
  }

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    // Detectar inicio de def o class
    const isDef = /^def\s+([A-Za-z0-9_]+)\s*\(|^async\s+def\s+([A-Za-z0-9_]+)\s*\(/.exec(trimmed)
    const isClass = /^class\s+([A-Za-z0-9_]+)/.exec(trimmed)

    if (isDef || isClass) {
      flushModule()
      const startIdx = i
      const name = isDef ? isDef[1] || isDef[2] || '(funcion)' : isClass![1] || '(clase)'
      const tipo: ChunkType = isClass ? 'class' : 'function'

      // Chequear decoradores previos
      let decStart = startIdx
      while (decStart > 0 && lines[decStart - 1]!.trim().startsWith('@')) {
        decStart--
      }

      // Medir la indentación base del bloque
      const baseIndentMatch = /^[ \t]*/.exec(lines[startIdx]!)
      const baseIndent = baseIndentMatch ? baseIndentMatch[0].length : 0

      // Avanzar hasta que termine el bloque indentado
      i++
      while (i < lines.length) {
        const nextLine = lines[i]!
        const nextTrimmed = nextLine.trim()
        if (nextTrimmed === '') {
          i++
          continue
        }
        const nextIndent = /^[ \t]*/.exec(nextLine)![0].length
        if (nextIndent <= baseIndent) {
          break
        }
        i++
      }

      const entityLines = lines.slice(decStart, i)
      const rawCode = entityLines.join('\n')
      const lineaInicio = decStart + 1
      const lineaFin = i
      const scope = `${archivo} > ${name}`
      const enriched = buildEnrichedText(archivo, rawCode, tipo, name, scope, lineaInicio, lineaFin, language)

      chunks.push({
        texto: enriched,
        codigo_puro: rawCode,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo,
        nombre: name,
        scope,
        lenguaje: language,
      })
      continue
    }

    if (!moduleLines.length) moduleStart = i + 1
    moduleLines.push(line)
    if (moduleLines.join('\n').length > maxChars) {
      flushModule()
    }
    i++
  }

  flushModule()
  return chunks
}

// -------------------------------------------------------------
// Chunking para Markdown (.md, .markdown)
// -------------------------------------------------------------
function chunkMarkdown(archivo: string, content: string, maxChars: number, language: string): CodeChunk[] {
  const lines = content.split('\n')
  const chunks: CodeChunk[] = []

  let currentSection: string[] = []
  let sectionStart = 1
  let currentHeader = 'Introducción'
  let inCodeBlock = false

  const flushSection = () => {
    if (!currentSection.length) return
    const raw = currentSection.join('\n').trim()
    if (raw.length > 15) {
      const lineaInicio = sectionStart
      const lineaFin = sectionStart + currentSection.length - 1
      const scope = `${archivo} > ${currentHeader}`
      const enriched = buildEnrichedText(archivo, raw, 'section', currentHeader, scope, lineaInicio, lineaFin, language)
      chunks.push({
        texto: enriched,
        codigo_puro: raw,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo: 'section',
        nombre: currentHeader,
        scope,
        lenguaje: language,
      })
    }
    currentSection = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock
    }

    const headerMatch = /^#{1,4}\s+(.+)$/.exec(trimmed)
    if (!inCodeBlock && headerMatch) {
      flushSection()
      currentHeader = headerMatch[1]?.trim() || 'Sección'
      sectionStart = i + 1
    }

    if (!currentSection.length) sectionStart = i + 1
    currentSection.push(line)

    if (!inCodeBlock && currentSection.join('\n').length > maxChars * 1.5) {
      flushSection()
    }
  }

  flushSection()
  return chunks
}

// -------------------------------------------------------------
// Fallback estructurado / por párrafos lógicos
// -------------------------------------------------------------
function chunkParagraphFallback(
  archivo: string,
  content: string,
  maxChars: number,
  overlapLines: number,
  language: string,
): CodeChunk[] {
  const lines = content.split('\n')
  const chunks: CodeChunk[] = []
  let actual: string[] = []
  let inicio = 0

  for (let i = 0; i < lines.length; i++) {
    actual.push(lines[i]!)
    const currentLen = actual.join('\n').length

    // Cortar preferiblemente en línea vacía o cierre de llave/bloque si excede maxChars
    const isNaturalBreak = lines[i]!.trim() === '' || lines[i]!.trim() === '}' || lines[i]!.trim() === '};'

    if (currentLen > maxChars && (isNaturalBreak || currentLen > maxChars * 1.4)) {
      const raw = actual.join('\n').trim()
      if (raw.length > 0) {
        const lineaInicio = inicio + 1
        const lineaFin = i + 1
        const scope = `${archivo} > L${lineaInicio}-L${lineaFin}`
        const enriched = buildEnrichedText(
          archivo,
          raw,
          'block',
          `Bloque L${lineaInicio}-L${lineaFin}`,
          scope,
          lineaInicio,
          lineaFin,
          language,
        )

        chunks.push({
          texto: enriched,
          codigo_puro: raw,
          archivo,
          linea_inicio: lineaInicio,
          linea_fin: lineaFin,
          tipo: 'block',
          nombre: `L${lineaInicio}-L${lineaFin}`,
          scope,
          lenguaje: language,
        })
      }

      if (overlapLines > 0) {
        actual = actual.slice(-overlapLines)
        inicio = Math.max(0, i - overlapLines + 1)
      } else {
        actual = []
        inicio = i + 1
      }
    }
  }

  if (actual.length) {
    const raw = actual.join('\n').trim()
    if (raw.length > 0) {
      const lineaInicio = inicio + 1
      const lineaFin = lines.length
      const scope = `${archivo} > L${lineaInicio}-L${lineaFin}`
      const enriched = buildEnrichedText(
        archivo,
        raw,
        'block',
        `Bloque L${lineaInicio}-L${lineaFin}`,
        scope,
        lineaInicio,
        lineaFin,
        language,
      )

      chunks.push({
        texto: enriched,
        codigo_puro: raw,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo: 'block',
        nombre: `L${lineaInicio}-L${lineaFin}`,
        scope,
        lenguaje: language,
      })
    }
  }

  return chunks
}

// -------------------------------------------------------------
// Parser / Regex Chunking para PHP (.php)
// -------------------------------------------------------------
function chunkPhp(archivo: string, content: string, _maxChars: number, language: string): CodeChunk[] {
  const lines = content.split('\n')
  const chunks: CodeChunk[] = []

  let unbundled: string[] = []
  let unbundledStart = 1
  let currentClass: string | null = null
  let classType: ChunkType = 'class'

  const flushUnbundled = (tipo: ChunkType = 'module', nombre: string = 'modulo/declaraciones') => {
    if (!unbundled.length) return
    const raw = unbundled.join('\n').trim()
    if (raw.length > 25) {
      const lineaInicio = unbundledStart
      const lineaFin = unbundledStart + unbundled.length - 1
      const scope = currentClass ? `${archivo} > ${currentClass} (definicion)` : `${archivo} > ${nombre}`
      const enriched = buildEnrichedText(archivo, raw, tipo, nombre, scope, lineaInicio, lineaFin, language)
      chunks.push({
        texto: enriched,
        codigo_puro: raw,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo,
        nombre,
        scope,
        lenguaje: language,
      })
    }
    unbundled = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    // Detectar clase, interfaz o trait
    const classMatch = /^(?:abstract\s+|final\s+)?(class|interface|trait)\s+([A-Za-z0-9_]+)/.exec(trimmed)
    if (classMatch) {
      flushUnbundled()
      const cTypeStr = classMatch[1]
      currentClass = classMatch[2] || '(clase)'
      classType = cTypeStr === 'interface' ? 'interface' : 'class'
      unbundledStart = i + 1
      unbundled.push(line)
      i++
      continue
    }

    // Detectar funcion o metodo
    const funcMatch = /^(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+&?\s*([A-Za-z0-9_]+)\s*\(/.exec(trimmed)
    if (funcMatch) {
      flushUnbundled(classType, currentClass ? `${currentClass} (propiedades)` : 'modulo/declaraciones')
      const funcName = funcMatch[1] || '(funcion)'
      const isMethod = !!currentClass
      const tipo: ChunkType = isMethod ? 'method' : 'function'
      const funcStart = i
      const signature = trimmed.replace(/\{.*$/, '').trim()

      // Buscar fin de la funcion rastreando llaves
      let braceCount = 0
      let hasOpenedBrace = false
      let funcEnd = i

      for (let j = i; j < lines.length; j++) {
        const curLine = lines[j]!
        for (let c = 0; c < curLine.length; c++) {
          const char = curLine[c]
          if (char === '{') {
            braceCount++
            hasOpenedBrace = true
          } else if (char === '}') {
            braceCount--
          }
        }

        // Si es una funcion abstracta o de interfaz que termina con ';' sin llaves
        if (!hasOpenedBrace && curLine.includes(';') && j === i) {
          funcEnd = j
          break
        }

        if (hasOpenedBrace && braceCount <= 0) {
          funcEnd = j
          break
        }
        funcEnd = j
      }

      const entityLines = lines.slice(funcStart, funcEnd + 1)
      const rawCode = entityLines.join('\n')
      const lineaInicio = funcStart + 1
      const lineaFin = funcEnd + 1
      const scope = currentClass ? `${archivo} > ${currentClass}::${funcName}` : `${archivo} > ${funcName}`
      const enriched = buildEnrichedText(archivo, rawCode, tipo, funcName, scope, lineaInicio, lineaFin, language, signature)

      chunks.push({
        texto: enriched,
        codigo_puro: rawCode,
        archivo,
        linea_inicio: lineaInicio,
        linea_fin: lineaFin,
        tipo,
        nombre: funcName,
        scope,
        firma: signature,
        lenguaje: language,
      })

      i = funcEnd + 1
      unbundledStart = i + 1
      continue
    }

    if (!unbundled.length) {
      unbundledStart = i + 1
    }
    unbundled.push(line)
    i++
  }

  flushUnbundled(currentClass ? classType : 'module', currentClass || 'modulo/declaraciones')
  return chunks
}

// -------------------------------------------------------------
// Punto de entrada principal: chunkFileContent
// -------------------------------------------------------------
export function chunkFileContent(
  archivoRelativo: string,
  content: string,
  options?: ChunkerOptions,
): CodeChunk[] {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS
  const overlapLines = options?.overlapLines ?? DEFAULT_OVERLAP_LINES
  const lang = detectLanguage(archivoRelativo)

  try {
    if (['typescript', 'javascript'].includes(lang)) {
      const astChunks = chunkTypeScriptAst(archivoRelativo, content, maxChars, lang)
      if (astChunks.length > 0) return astChunks
    }

    if (lang === 'python') {
      const pyChunks = chunkPython(archivoRelativo, content, maxChars, lang)
      if (pyChunks.length > 0) return pyChunks
    }

    if (lang === 'php') {
      const phpChunks = chunkPhp(archivoRelativo, content, maxChars, lang)
      if (phpChunks.length > 0) return phpChunks
    }

    if (lang === 'markdown') {
      const mdChunks = chunkMarkdown(archivoRelativo, content, maxChars, lang)
      if (mdChunks.length > 0) return mdChunks
    }
  } catch (err) {
    // Si falla el AST por sintaxis inválida, caer en fallback seguro
    console.warn(`[Chunker] Warning en parser de ${archivoRelativo}, usando fallback estructurado:`, err)
  }

  return chunkParagraphFallback(archivoRelativo, content, maxChars, overlapLines, lang)
}

