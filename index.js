/**
 * dsh-paper-reader — host half.
 *
 * Serves everything the sidebar reader needs from one prefix route:
 *   /paper-reader/api/library   GET    paper index
 *   /paper-reader/api/upload    POST   raw PDF bytes -> stored paper
 *   /paper-reader/api/doc       GET/PATCH/DELETE  one paper's metadata + annotations
 *   /paper-reader/file          GET    original PDF bytes (Range capable)
 *   /paper-reader/static/*      GET    vendored pdf.js runtime, cmaps, standard fonts
 *
 * Papers live outside any single workspace (`~/.dsh/paper-reader/`) so the
 * library survives session switches: `<id>.pdf` is the untouched upload and
 * `<id>.json` carries the title, reading position and annotations.
 */
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { appendFile, cp, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

/** Plugin identity for the Loader row / client-modules keying. */
export const name = 'dsh-paper-reader'

/** Route registration + the web startup's trusted-host fence. */
export const inject = ['webServer', 'webStartup']

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(HERE, 'public')
const STORE_DIR = process.env.DSH_PAPER_READER_DIR !== undefined && process.env.DSH_PAPER_READER_DIR !== ''
  ? resolve(process.env.DSH_PAPER_READER_DIR)
  : join(homedir(), '.dsh', 'paper-reader')

/** One upload may carry at most this many bytes. */
const MAX_UPLOAD = 160 * 1024 * 1024
/** Metadata/annotation writes are small; anything larger is a mistake. */
const MAX_META_BODY = 8 * 1024 * 1024
/** Upper bound on stored annotations per paper. */
const MAX_ANNOTATIONS = 2000
/** Paper-level notes: short conclusions that outlive one session. */
const MAX_PAPER_NOTES = 500
const MAX_NOTE_CHARS = 2000

/** Settings file next to the papers; it never leaves this machine. */
const SETTINGS_PATH = join(STORE_DIR, 'settings.json')
const DEFAULT_SETTINGS = {
  workRoot: join(homedir(), '.paper_reading'),
  mineruApiKey: '',
  mineruModel: 'vlm',
  mineruLang: 'ch',
}

/** Running MinerU jobs, keyed by paper id; status also lands in the paper meta. */
const parseJobs = new Map()

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.bcmap': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
}

// ── browser-trust fence (same semantics as the /sidebar gateway) ─────────────

function header(headers, key) {
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── small HTTP helpers ───────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendError(res, status, message, code = 'error') {
  if (res.headersSent) {
    res.destroy()
    return
  }
  sendJson(res, status, { ok: false, error: { code, message } })
}

function readBody(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (status, message) => {
      if (settled) return
      settled = true
      const error = new Error(message)
      error.status = status
      rejectBody(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(413, `request body exceeds ${limit} bytes`)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolveBody(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      rejectBody(error)
    })
  })
}

function parseRange(raw, size) {
  if (raw === undefined) return null
  const match = /^bytes=(.+)$/i.exec(raw.trim())
  if (!match) return null
  const spec = match[1].split(',')[0].trim()
  if (spec === '') return null
  if (spec.startsWith('-')) {
    const suffix = Number(spec.slice(1))
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    if (suffix >= size) return { start: 0, end: size - 1 }
    return { start: size - suffix, end: size - 1 }
  }
  const dash = spec.indexOf('-')
  if (dash === -1) return null
  const startText = spec.slice(0, dash)
  const endText = spec.slice(dash + 1)
  const start = startText === '' ? 0 : Number(startText)
  const end = endText === '' ? size - 1 : Number(endText)
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end)) return null
  if (start >= size) return { unsatisfiable: true }
  return { start, end: Math.min(end, size - 1) }
}

function serveFile(req, res, path, size, type, extraHeaders = {}) {
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    ...extraHeaders,
  }
  const range = parseRange(header(req.headers, 'range'), size)
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    res.end()
    return
  }
  if (range !== null) {
    const { start, end } = range
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(path, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(path)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

// ── storage ──────────────────────────────────────────────────────────────────

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function docId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : ''
  return ID_RE.test(id) ? id : undefined
}

function expandHome(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pdfPath(id) {
  return join(STORE_DIR, `${id}.pdf`)
}

function metaPath(id) {
  return join(STORE_DIR, `${id}.json`)
}

async function ensureStore() {
  await mkdir(STORE_DIR, { recursive: true })
}

async function readMeta(id) {
  const text = await readFile(metaPath(id), 'utf8')
  const meta = JSON.parse(text)
  return normalizeMeta(meta, id)
}

function normalizeMeta(meta, id) {
  return {
    id,
    title: typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title.trim() : 'Untitled paper',
    fileName: typeof meta.fileName === 'string' ? meta.fileName : '',
    size: Number.isFinite(meta.size) ? meta.size : 0,
    createdAt: Number.isFinite(meta.createdAt) ? meta.createdAt : Date.now(),
    updatedAt: Number.isFinite(meta.updatedAt) ? meta.updatedAt : Date.now(),
    pageCount: Number.isInteger(meta.pageCount) && meta.pageCount > 0 ? meta.pageCount : null,
    lastPage: Number.isInteger(meta.lastPage) && meta.lastPage > 0 ? meta.lastPage : 1,
    scrollRatio: Number.isFinite(meta.scrollRatio) ? Math.min(Math.max(meta.scrollRatio, 0), 1) : 0,
    annotations: Array.isArray(meta.annotations) ? meta.annotations.map(normalizeAnnotation).filter(Boolean) : [],
    paperNotes: Array.isArray(meta.paperNotes) ? meta.paperNotes.map(normalizePaperNote).filter(Boolean).slice(0, MAX_PAPER_NOTES) : [],
    code: normalizeCode(meta.code),
    keywords: Array.isArray(meta.keywords)
      ? meta.keywords.filter((word) => typeof word === 'string' && word.trim() !== '').map((word) => word.trim().slice(0, 24)).slice(0, 8)
      : [],
    workDir: typeof meta.workDir === 'string' ? meta.workDir.slice(0, 4000) : '',
    parse: normalizeParse(meta.parse),
  }
}

function normalizeCode(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const clone = value.clone !== null && typeof value.clone === 'object' ? value.clone : {}
  const status = ['idle', 'running', 'done', 'error'].includes(clone.status) ? clone.status : 'idle'
  return {
    repo: typeof value.repo === 'string' ? value.repo.slice(0, 2000) : '',
    note: typeof value.note === 'string' ? value.note.slice(0, 20000) : '',
    clone: {
      status,
      message: typeof clone.message === 'string' ? clone.message.slice(0, 500) : '',
      startedAt: Number.isFinite(clone.startedAt) ? clone.startedAt : 0,
      finishedAt: Number.isFinite(clone.finishedAt) ? clone.finishedAt : 0,
    },
  }
}

/** Independent counts for the two code trees under the paper folder. */
function codeCount(dir) {
  return readdir(dir).then((entries) => entries.length).catch(() => 0)
}

/**
 * The paper folder's meta file: everything a fresh session needs to know before
 * it opens a single page, without asking the reader UI.
 */
function renderPaperMeta(meta, info) {
  const keywords = Array.isArray(meta.keywords) ? meta.keywords : []
  const parse = meta.parse === undefined ? { status: 'idle' } : meta.parse
  const repo = meta.code.repo === '' ? '未关联' : meta.code.repo
  const clone = meta.code.clone === undefined ? { status: 'idle' } : meta.code.clone
  const cloneLine = clone.status === 'running'
    ? '克隆中'
    : clone.status === 'error'
      ? `克隆失败：${clone.message}`
      : clone.status === 'done'
        ? '已克隆'
        : '未克隆'
  const parsedLabel = parse.status === 'done'
    ? (info.markdown === '' ? '完成' : String(info.markdown).replace(info.dir + '/', ''))
    : parse.status === 'running' ? '进行中' : '未解析'
  return [
    `# ${meta.title}`,
    '',
    `- paper id: ${meta.id}`,
    `- 页数: ${meta.pageCount === null ? '未知' : meta.pageCount}`,
    `- 领域关键词: ${keywords.length === 0 ? '（未标注）' : keywords.join('、')}`,
    `- 开源仓库: ${repo}（${cloneLine}；remote/ ${info.remoteFiles} 项）`,
    `- 本地复现: local/ ${info.localFiles} 项`,
    `- 解析: ${parsedLabel}`,
    `- 原文: pdf/${info.fileName}`,
    '',
    '## 目录',
    '',
    '- `pdf/` 原始 PDF',
    '- `markdown/` 解析正文，可能带 `images/`',
    '- `remote/` 开源实现（克隆来的）',
    '- `local/` 本地复现代码',
    '- `notes.md` 标注与笔记（唯一可读文档）',
    '- `meta.md` 本文件',
    '',
  ].join('\n')
}

function normalizeParse(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const status = ['idle', 'running', 'done', 'error'].includes(value.status) ? value.status : 'idle'
  const engine = value.engine === 'mineru' ? 'mineru' : 'markdown'
  const progress = Number.isFinite(value.progress) ? Math.min(Math.max(value.progress, 0), 1) : status === 'done' ? 1 : 0
  return {
    status,
    engine,
    progress,
    dir: typeof value.dir === 'string' ? value.dir.slice(0, 2000) : '',
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : 0,
    finishedAt: Number.isFinite(value.finishedAt) ? value.finishedAt : 0,
    error: typeof value.error === 'string' ? value.error.slice(0, 2000) : '',
  }
}

function normalizePaperNote(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_NOTE_CHARS) : ''
  if (text === '') return undefined
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 80) : randomUUID(),
    title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 48) : '',
    text,
    author: raw.author === 'ai' ? 'ai' : 'human',
    sourceSessionId: '',
    sourceSessionTitle: '',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

function clamp01(value) {
  return Math.min(Math.max(Number(value), 0), 1)
}

function normalizeAnnotation(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const rects = Array.isArray(raw.rects)
    ? raw.rects
        .filter((rect) => Array.isArray(rect) && rect.length === 4 && rect.every((n) => Number.isFinite(n)))
        .slice(0, 400)
        .map((rect) => [clamp01(rect[0]), clamp01(rect[1]), clamp01(rect[2]), clamp01(rect[3])])
    : []
  const page = Number.isInteger(raw.page) && raw.page > 0 ? raw.page : 1
  const kind = raw.kind === 'note' ? 'note' : 'highlight'
  const text = typeof raw.text === 'string' ? raw.text.slice(0, 20000) : ''
  // A model-authored annotation anchors at page level: it has no viewport
  // geometry to draw from, so an empty rect list is valid as long as it says
  // something.
  if (rects.length === 0 && text === '' && typeof raw.note !== 'string') return undefined
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 80) : randomUUID(),
    kind,
    page,
    rects,
    text,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 20000) : '',
    color: typeof raw.color === 'string' ? raw.color.slice(0, 24) : '',
    author: raw.author === 'ai' ? 'ai' : 'human',
    sourceSessionId: typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId.slice(0, 80) : '',
    sourceSessionTitle: typeof raw.sourceSessionTitle === 'string' ? raw.sourceSessionTitle.slice(0, 200) : '',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  }
}

function summaryOf(meta) {
  return {
    id: meta.id,
    title: meta.title,
    fileName: meta.fileName,
    size: meta.size,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pageCount: meta.pageCount,
    lastPage: meta.lastPage,
    highlightCount: meta.annotations.filter((a) => a.kind === 'highlight').length,
    noteCount: meta.annotations.filter((a) => a.kind === 'note').length,
    aiCount: meta.annotations.filter((a) => a.author === 'ai').length,
    paperNoteCount: meta.paperNotes.length,
    parseStatus: meta.parse.status,
    codeRepo: meta.code.repo,
    keywords: meta.keywords,
  }
}

async function writeMeta(meta) {
  await ensureStore()
  const target = metaPath(meta.id)
  const temp = `${target}.tmp-${process.pid}`
  await writeFile(temp, JSON.stringify(meta, null, 2))
  await rename(temp, target)
}

async function listLibrary() {
  await ensureStore()
  const names = await readdir(STORE_DIR).catch(() => [])
  const docs = []
  for (const entry of names) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    if (!ID_RE.test(id)) continue
    try {
      docs.push(summaryOf(await readMeta(id)))
    } catch {
      // A half-written or foreign JSON file is skipped, never fatal.
    }
  }
  docs.sort((a, b) => b.updatedAt - a.updatedAt)
  return docs
}

// ── settings ─────────────────────────────────────────────────────────────────

async function readSettings() {
  try {
    const text = await readFile(SETTINGS_PATH, 'utf8')
    const stored = JSON.parse(text)
    const merged = { ...DEFAULT_SETTINGS }
    if (typeof stored.workRoot === 'string' && stored.workRoot.trim() !== '') merged.workRoot = expandHome(stored.workRoot.trim())
    if (typeof stored.mineruApiKey === 'string') merged.mineruApiKey = stored.mineruApiKey.trim()
    if (['vlm', 'pipeline', 'MinerU-HTML'].includes(stored.mineruModel)) merged.mineruModel = stored.mineruModel
    if (typeof stored.mineruLang === 'string' && stored.mineruLang.trim() !== '') merged.mineruLang = stored.mineruLang.trim()
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function writeSettings(patch) {
  const current = await readSettings()
  if (typeof patch.workRoot === 'string' && patch.workRoot.trim() !== '') current.workRoot = expandHome(patch.workRoot.trim())
  if (typeof patch.mineruApiKey === 'string') current.mineruApiKey = patch.mineruApiKey.trim()
  if (['vlm', 'pipeline', 'MinerU-HTML'].includes(patch.mineruModel)) current.mineruModel = patch.mineruModel
  if (typeof patch.mineruLang === 'string' && patch.mineruLang.trim() !== '') current.mineruLang = patch.mineruLang.trim()
  await ensureStore()
  const temp = `${SETTINGS_PATH}.tmp-${process.pid}`
  await writeFile(temp, JSON.stringify(current, null, 2))
  await rename(temp, SETTINGS_PATH)
  return current
}

/** Settings as shown in the UI: the API key is redacted to its last four characters. */
function publicSettings(settings) {
  const key = settings.mineruApiKey
  return {
    workRoot: settings.workRoot,
    mineruModel: settings.mineruModel,
    mineruLang: settings.mineruLang,
    mineruApiKeySet: key !== '',
    mineruApiKeyHint: key === '' ? '' : `••••${key.slice(-4)}`,
  }
}

// ── paper folders: <workRoot>/<paper>/{pdf,markdown,code} ────────────────────

function slugOf(meta) {
  const base = meta.title !== '' ? meta.title : meta.fileName !== '' ? meta.fileName : meta.id
  const cleaned = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return cleaned === '' ? meta.id : cleaned
}

/**
 * Materialize the paper's folder and return its parts. The folder is created
 * once and then reused, so renaming a paper never moves its files.
 */
/**
 * Clone in the background: a GitHub checkout takes long enough that the request
 * must answer first and the UI poll for the status.
 */
async function startClone(id) {
  const meta = await readMeta(id)
  if (meta.code.repo === '' || !/^https?:\/\//i.test(meta.code.repo)) {
    throw Object.assign(new Error('先在开源仓库一栏填一个 http(s) 地址'), { status: 400 })
  }
  if (meta.code.clone.status === 'running') return meta.code.clone
  const folder = await paperFolder(id)
  const existing = await readdir(folder.remoteDir).catch(() => [])
  if (existing.length > 0) {
    throw Object.assign(new Error('remote/ 已经有内容了'), { status: 409 })
  }
  const startedAt = Date.now()
  meta.code = normalizeCode({ ...meta.code, clone: { status: 'running', message: '', startedAt, finishedAt: 0 } })
  await writeMeta(meta)
  const repo = meta.code.repo
  void cloneInto(repo, folder.remoteDir)
    .then(async () => {
      const next = await readMeta(id)
      next.code = normalizeCode({ ...next.code, clone: { status: 'done', message: '', startedAt, finishedAt: Date.now() } })
      await writeMeta(next)
      await paperBrief(id).catch(() => {})
    })
    .catch(async (error) => {
      const next = await readMeta(id)
      next.code = normalizeCode({ ...next.code, clone: { status: 'error', message: String(error?.message ?? error).slice(0, 400), startedAt, finishedAt: Date.now() } })
      await writeMeta(next)
      await paperBrief(id).catch(() => {})
    })
  return meta.code.clone
}

/** Shallow clone into the paper's code folder. */
function cloneInto(repo, target) {
  return new Promise((resolveClone, rejectClone) => {
    const child = spawn('git', ['clone', '--depth', '1', repo, target], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectClone(Object.assign(new Error('git clone 超时（120 秒）'), { status: 504 }))
    }, 120000)
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectClone(Object.assign(new Error(`git clone 失败：${error.message}`), { status: 500 }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveClone()
      else rejectClone(Object.assign(new Error(`git clone 失败：${stderr.trim().split('\n').slice(-1)[0] || 'exit ' + code}`), { status: 500 }))
    })
  })
}

async function paperFolder(id) {
  const meta = await readMeta(id)
  const settings = await readSettings()
  const dir = meta.workDir !== '' ? meta.workDir : join(settings.workRoot, slugOf(meta))
  const pdfDir = join(dir, 'pdf')
  const mdDir = join(dir, 'markdown')
  const remoteDir = join(dir, 'remote')
  const localDir = join(dir, 'local')
  await mkdir(pdfDir, { recursive: true })
  await mkdir(mdDir, { recursive: true })
  await mkdir(remoteDir, { recursive: true })
  await mkdir(localDir, { recursive: true })

  const rawName = (meta.fileName !== '' ? meta.fileName : 'paper.pdf').replace(/[\\/:*?"<>|]/g, ' ').trim()
  const fileName = rawName === '' ? 'paper.pdf' : rawName.toLowerCase().endsWith('.pdf') ? rawName : `${rawName}.pdf`
  const pdfTarget = join(pdfDir, fileName)
  const existing = await stat(pdfTarget).catch(() => undefined)
  if (existing === undefined) await cp(pdfPath(id), pdfTarget, { force: true })

  if (meta.workDir !== dir) {
    meta.workDir = dir
    await writeMeta(meta).catch(() => {})
  }
  return { meta, settings, dir, pdfDir, mdDir, remoteDir, localDir, pdfTarget, fileName }
}

/** Refresh the folder's notes.md after annotations or notes change elsewhere. */
async function syncPaperNotes(meta) {
  if (meta.workDir === '') return
  await writeFile(join(meta.workDir, 'notes.md'), renderNotesMarkdown(meta)).catch(() => {})
}

async function paperBrief(id) {
  const folder = await paperFolder(id)
  await writeFile(join(folder.dir, 'notes.md'), renderNotesMarkdown(folder.meta)).catch(() => {})
  const markdown = await findMarkdown(folder.mdDir)
  const remoteFiles = await codeCount(folder.remoteDir)
  const localFiles = await codeCount(folder.localDir)
  await writeFile(join(folder.dir, 'meta.md'), renderPaperMeta(folder.meta, {
    dir: folder.dir,
    markdown,
    fileName: folder.fileName,
    remoteFiles,
    localFiles,
  })).catch(() => {})
  await rm(join(folder.dir, 'README.md'), { force: true }).catch(() => {})
  return {
    path: folder.dir,
    pdf: folder.pdfTarget,
    markdown,
    remote: { path: folder.remoteDir, files: remoteFiles },
    local: { path: folder.localDir, files: localFiles },
    code: { repo: folder.meta.code.repo, clone: folder.meta.code.clone },
    keywords: folder.meta.keywords,
    parse: folder.meta.parse,
  }
}

/**
 * What the paper's markdown folder actually holds: whether a markdown file
 * exists, and whether it came with extracted figures (which only MinerU
 * produces, markitdown writes plain text).
 */
async function markdownState(meta) {
  if (meta.workDir === '') return { exists: false, hasImages: false }
  const found = await findMarkdown(join(meta.workDir, 'markdown'))
  if (found === '') return { exists: false, hasImages: false }
  const images = await readdir(join(dirname(found), 'images')).catch(() => [])
  return { exists: true, hasImages: images.length > 0 }
}

async function findMarkdown(dir) {
  const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const direct = names.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'paper.md')
  if (direct !== undefined) return join(dir, direct.name)
  for (const entry of names) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) return join(dir, entry.name)
  }
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const nested = await findMarkdown(join(dir, entry.name))
    if (nested !== '') return nested
  }
  return ''
}

/** The paper's one readable document: big notes first, then page-ordered annotations. */
function noteHeading(note) {
  if (typeof note.title === 'string' && note.title !== '') return note.title
  const enclosed = /^【([^】]{1,24})】/.exec(note.text)
  if (enclosed !== null) return enclosed[1]
  const prefixed = /^([^：:\n]{2,12})[：:]/.exec(note.text)
  if (prefixed !== null) return prefixed[1]
  if (/^已读/.test(note.text)) return '已读'
  return '笔记'
}

/** Drop a label the body repeats: the heading already carries it. */
function bodyOfNote(note) {
  const text = note.text
  const heading = noteHeading(note)
  for (const marker of [`${heading}：`, `${heading}:`, `【${heading}】`]) {
    if (text.startsWith(marker)) return text.slice(marker.length).trim()
  }
  return text
}

function renderNotesMarkdown(meta) {
  const stamp = new Date().toISOString()
  const lines = [`# ${meta.title}`, '', `${meta.annotations.length} 条标注 · ${meta.paperNotes.length} 条笔记 · 更新于 ${stamp}`, '']
  if (meta.paperNotes.length > 0) {
    lines.push('## 笔记', '')
    const notes = meta.paperNotes.slice().sort((a, b) => a.createdAt - b.createdAt)
    for (const note of notes) {
      lines.push(`### ${noteHeading(note)}`, '', bodyOfNote(note), '')
    }
  }
  if (meta.annotations.length > 0) {
    lines.push('## 标注', '')
    const ordered = meta.annotations.slice().sort((a, b) => (a.page === b.page ? a.createdAt - b.createdAt : a.page - b.page))
    for (const annotation of ordered) {
      const author = annotation.author === 'ai' ? 'AI' : 'human'
      lines.push(`### p${annotation.page} · ${annotation.kind} · ${author}`)
      if (annotation.text !== '') lines.push('', `> ${annotation.text.replace(/\n/g, '\n> ')}`)
      if (annotation.note !== '') lines.push('', annotation.note)
      lines.push('')
    }
  }
  return lines.join('\n')
}

// ── parsing: markitdown by default, MinerU on request ────────────────────────

/**
 * Local markitdown conversion costs roughly 0.25s per page plus a fixed
 * interpreter start; the bar is calibrated on that, not on a flat guess.
 */
function localParseEstimate(pageCount) {
  return 1500 + Math.max(pageCount, 1) * 260
}

async function patchParse(id, patch) {
  try {
    const meta = await readMeta(id)
    meta.parse = normalizeParse({ ...meta.parse, ...patch })
    meta.updatedAt = Date.now()
    await writeMeta(meta)
  } catch {
    // A vanished paper does not fail the job record.
  }
}

/** Stop whatever parse runs for this paper; the job record keeps the reason. */
function stopParse(id, reason) {
  const job = parseJobs.get(id)
  if (job === undefined) return
  job.halted = reason
  const child = job.child
  job.child = undefined
  if (job.abort !== undefined) {
    try { job.abort.abort() } catch { /* already settled */ }
    job.abort = undefined
  }
  if (job.timer !== undefined) {
    clearInterval(job.timer)
    job.timer = undefined
  }
  if (child !== undefined) {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
  parseJobs.delete(id)
  patchParse(id, { status: 'idle', engine: job.engine, progress: 0, error: reason === 'replaced' ? '' : reason })
}

/** MinerU cloud API root; the token is the only credential. */
const MINERU_API = process.env.DSH_PAPER_READER_MINERU_API ?? 'https://mineru.net/api/v4'
/** Polling cadence and ceiling for one MinerU batch. */
const MINERU_POLL_MS = 3000
const MINERU_DEADLINE_MS = 15 * 60 * 1000

function startParse(id, engine) {
  stopParse(id, 'replaced')

  const job = {
    status: 'running',
    engine,
    progress: 0,
    dir: '',
    startedAt: Date.now(),
    finishedAt: 0,
    error: '',
    child: undefined,
    timer: undefined,
    abort: undefined,
  }
  parseJobs.set(id, job)

  const finish = (failed, message) => {
    if (job.timer !== undefined) {
      clearInterval(job.timer)
      job.timer = undefined
    }
    job.child = undefined
    job.abort = undefined
    if (parseJobs.get(id) !== job) return
    const next = {
      status: failed ? 'error' : 'done',
      engine,
      progress: failed ? job.progress : 1,
      dir: job.dir,
      startedAt: job.startedAt,
      finishedAt: Date.now(),
      error: failed ? String(message ?? '').slice(-1800) : '',
    }
    parseJobs.delete(id)
    patchParse(id, next)
  }

  const report = (progress) => {
    if (parseJobs.get(id) !== job) return
    if (progress > job.progress) job.progress = Math.min(0.99, progress)
    patchParse(id, { status: 'running', engine, progress: job.progress, dir: job.dir, startedAt: job.startedAt, finishedAt: 0, error: '' })
  }

  paperFolder(id).then((folder) => {
    if (parseJobs.get(id) !== job) return
    job.dir = folder.dir
    report(0.02)

    if (engine === 'mineru') {
      runMineru(job, folder, report).then(() => finish(false, '')).catch((error) => {
        if (parseJobs.get(id) !== job) return
        finish(true, error?.message ?? String(error))
      })
      return
    }

    // markitdown: the named conversion tool, spawned through uvx.
    let child
    try {
      child = spawn('uvx', ['--from', 'markitdown[pdf]', 'markitdown', folder.pdfTarget, '-o', join(folder.mdDir, 'paper.md')], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(true, String(error?.message ?? error))
      return
    }
    job.child = child
    let tail = ''
    const collect = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-4000)
      const match = /(\d{1,3})\s*%/.exec(tail.slice(-400))
      if (match !== null) report(Number(match[1]) / 100)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const estimate = localParseEstimate(folder.meta.pageCount ?? 0)
    job.timer = setInterval(() => {
      if (parseJobs.get(id) !== job) return
      report(Math.min(0.95, (Date.now() - job.startedAt) / estimate))
    }, 400)

    child.on('error', (error) => {
      finish(true, error.code === 'ENOENT' ? 'uvx not found on PATH; install uv to parse with markitdown' : String(error?.message ?? error))
    })
    child.on('close', (code) => {
      if (parseJobs.get(id) !== job) return
      finish(code !== 0, code !== 0 ? (tail.trim() === '' ? `exit code ${code}` : tail.trim()) : '')
    })
  }).catch((error) => {
    finish(true, error?.message ?? String(error))
  })

  return { status: 'running', engine, progress: 0, dir: '', startedAt: job.startedAt, finishedAt: 0, error: '' }
}

/** One JSON request against the MinerU API; throws with the service's own message. */
async function mineruRequest(path, token, init) {
  const response = await fetch(`${MINERU_API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    const detail = await response.json().then((body) => body?.msg ?? '').catch(() => '')
    throw new Error(`MinerU ${path} failed: HTTP ${response.status}${detail === '' ? '' : ` — ${detail}`}`)
  }
  const body = await response.json()
  if (!(body.code === 0 || body.success === true)) throw new Error(`MinerU: ${body.msg ?? 'request rejected'}`)
  return body.data ?? body
}

/**
 * The whole MinerU round trip in this process: ask for a presigned upload,
 * PUT the PDF, poll the batch, then unzip the result into markdown/.
 */
async function runMineru(job, folder, report) {
  const token = folder.settings.mineruApiKey
  if (token === '') throw new Error('MinerU API key is not configured')

  const abort = new AbortController()
  job.abort = abort
  const file = await readFile(folder.pdfTarget)
  report(0.06)

  const created = await mineruRequest('/file-urls/batch', token, {
    method: 'POST',
    signal: abort.signal,
    body: JSON.stringify({
      enable_formula: true,
      language: folder.settings.mineruLang,
      layout_model: 'doclayout_yolo',
      enable_table: true,
      files: [{
        name: folder.fileName,
        language: folder.settings.mineruLang,
        enable_table: true,
        enable_formula: true,
        is_ocr: false,
      }],
    }),
  })
  const batchId = created.batch_id
  const uploadUrl = Array.isArray(created.file_urls) && created.file_urls.length > 0
    ? typeof created.file_urls[0] === 'string' ? created.file_urls[0] : created.file_urls[0].url ?? created.file_urls[0].upload_url
    : ''
  if (typeof batchId !== 'string' || uploadUrl === undefined || uploadUrl === '') throw new Error('MinerU did not return an upload slot')
  report(0.12)

  const upload = await fetch(uploadUrl, { method: 'PUT', body: file, signal: abort.signal })
  if (upload.status !== 200 && upload.status !== 201) throw new Error(`MinerU upload failed: HTTP ${upload.status}`)
  report(0.24)

  const entry = await mineruPollBatch(batchId, token, abort.signal, job, report)
  report(0.9)

  const zipUrl = entry.full_zip_url ?? entry.zip_url ?? ''
  if (zipUrl === '') throw new Error('MinerU returned no result archive')
  const zip = await fetch(zipUrl, { signal: abort.signal })
  if (!zip.ok) throw new Error(`MinerU result download failed: HTTP ${zip.status}`)
  const archive = Buffer.from(await zip.arrayBuffer())

  await writeZipInto(archive, folder.mdDir)
  report(1)
}

/** Poll one batch until its single file finishes, fails, or the deadline passes. */
async function mineruPollBatch(batchId, token, signal, job, report) {
  const startedAt = Date.now()
  let polls = 0
  while (Date.now() - startedAt < MINERU_DEADLINE_MS) {
    polls += 1
    if (job.abort === undefined) throw new Error('parse cancelled')
    const data = await mineruRequest(`/extract-results/batch/${batchId}`, token, { signal })
    const results = Array.isArray(data.extract_result) ? data.extract_result : []
    if (results.length > 0) {
      const entry = results[0]
      if (entry.state === 'done') return entry
      if (entry.state === 'failed') throw new Error(`MinerU: ${entry.err_msg ?? 'parse failed'}`)
    }
    // Queued and running both read as steady progress under the 90% mark.
    report(Math.min(0.88, 0.24 + polls * 0.04))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, MINERU_POLL_MS))
  }
  throw new Error('MinerU timed out after 15 minutes')
}

/**
 * Read a ZIP archive with zlib only: the result bundle carries one markdown
 * file plus its images, so a central-directory walk is all this needs.
 */
function unzipEntries(buffer) {
  let eocd = -1
  const floor = Math.max(0, buffer.length - 66000)
  for (let i = buffer.length - 22; i >= floor; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('MinerU result is not a ZIP archive')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const raw = buffer.subarray(dataStart, dataStart + compressedSize)
      entries.push({ name, method, raw })
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Write the archive's markdown and images into the paper's markdown/ folder. */
async function writeZipInto(archive, mdDir) {
  const entries = unzipEntries(archive)
  const decode = (entry) => (entry.method === 0 ? entry.raw : inflateRawSync(entry.raw))

  const markdown = entries
    .filter((entry) => !entry.name.endsWith('/') && entry.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.name.length - b.name.length)[0]
  if (markdown === undefined) throw new Error('MinerU result carries no markdown')

  await mkdir(mdDir, { recursive: true })
  await writeFile(join(mdDir, 'paper.md'), decode(markdown))

  const imageEntries = entries.filter((entry) => !entry.name.endsWith('/') && entry.name.includes('images/'))
  if (imageEntries.length > 0) await mkdir(join(mdDir, 'images'), { recursive: true })
  let images = 0
  for (const entry of imageEntries) {
    const localName = entry.name.slice(entry.name.lastIndexOf('/') + 1)
    if (localName === '') continue
    await writeFile(join(mdDir, 'images', localName), decode(entry))
    images += 1
  }
  return { images }
}

/** The live job if one runs, else the persisted parse record. */
async function parseStateOf(id) {
  const live = parseJobs.get(id)
  if (live !== undefined) {
    return {
      status: 'running',
      engine: live.engine,
      progress: live.progress,
      dir: live.dir,
      startedAt: live.startedAt,
      finishedAt: 0,
      error: '',
    }
  }
  const meta = await readMeta(id)
  return meta.parse
}

/** List one directory for the code panel; names only, no recursion. */
async function listDirectory(rawPath) {
  const requested = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (requested === '') throw Object.assign(new Error('missing path'), { status: 400 })
  const expanded = requested.startsWith('~/') ? join(homedir(), requested.slice(2)) : requested
  const target = resolve(expanded)
  const info = await stat(target).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${target}`), { status: 400 })
  }
  const names = await readdir(target, { withFileTypes: true })
  const entries = []
  for (const name of names) {
    if (name.name.startsWith('.') && name.name !== '.gitignore') continue
    if (name.name === 'node_modules' || name.name === '.git') continue
    const child = join(target, name.name)
    let size = 0
    if (name.isFile()) {
      const childInfo = await stat(child).catch(() => undefined)
      size = childInfo?.size ?? 0
    }
    entries.push({ name: name.name, dir: name.isDirectory(), size })
    if (entries.length >= 400) break
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return { path: target, entries }
}

// ── route handler ────────────────────────────────────────────────────────────

async function handleApi(req, res, url, fence) {
  if (!fence(req)) {
    sendError(res, 403, 'forbidden', 'forbidden')
    return true
  }
  const pathname = url.pathname

  if (pathname === '/paper-reader/api/library') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    sendJson(res, 200, { ok: true, docs: await listLibrary() })
    return true
  }

  if (pathname === '/paper-reader/api/upload') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const body = await readBody(req, MAX_UPLOAD)
    if (body.length < 5 || body.subarray(0, 5).toString('latin1') !== '%PDF-') {
      sendError(res, 400, 'not a PDF file', 'not-pdf')
      return true
    }
    const id = randomUUID()
    const requestedName = url.searchParams.get('name') ?? ''
    const fileName = requestedName.trim().slice(0, 300) || 'paper.pdf'
    const requestedTitle = (url.searchParams.get('title') ?? '').trim()
    const title = (requestedTitle || fileName.replace(/\.pdf$/i, '')).slice(0, 300)
    await ensureStore()
    await writeFile(pdfPath(id), body)
    const now = Date.now()
    const meta = normalizeMeta({
      title,
      fileName,
      size: body.length,
      createdAt: now,
      updatedAt: now,
      pageCount: null,
      lastPage: 1,
      scrollRatio: 0,
      annotations: [],
    }, id)
    await writeMeta(meta)
    sendJson(res, 201, { ok: true, doc: summaryOf(meta) })
    return true
  }

  if (pathname === '/paper-reader/api/doc') {
    const id = docId(url.searchParams.get('id'))
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    if (req.method === 'GET') {
      try {
        const meta = await readMeta(id)
        const markdown = await markdownState(meta)
        sendJson(res, 200, { ok: true, doc: { ...meta, hasMarkdown: markdown.exists, markdownHasImages: markdown.hasImages } })
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
      }
      return true
    }
    if (req.method === 'PATCH') {
      let meta
      try {
        meta = await readMeta(id)
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
        return true
      }
      const body = JSON.parse((await readBody(req, MAX_META_BODY)).toString('utf8') || '{}')
      await appendFile(join(STORE_DIR, 'telemetry.jsonl'), JSON.stringify({
        at: new Date().toISOString(),
        kind: 'patch',
        id,
        keys: Object.keys(body),
        annots: Array.isArray(body.annotations) ? body.annotations.length : null,
        notes: Array.isArray(body.paperNotes) ? body.paperNotes.length : null
      }) + '\n').catch(() => {})
      if (typeof body.title === 'string' && body.title.trim() !== '') meta.title = body.title.trim().slice(0, 300)
      if (Number.isInteger(body.pageCount) && body.pageCount > 0) meta.pageCount = body.pageCount
      if (Number.isInteger(body.lastPage) && body.lastPage > 0) meta.lastPage = body.lastPage
      if (Number.isFinite(body.scrollRatio)) meta.scrollRatio = Math.min(Math.max(body.scrollRatio, 0), 1)
      if (Array.isArray(body.paperNotes)) {
        meta.paperNotes = body.paperNotes.map(normalizePaperNote).filter(Boolean).slice(0, MAX_PAPER_NOTES)
      }
      if (Array.isArray(body.annotations)) {
        // Guard: an empty list from a client that never loaded the annotations
        // would erase them for everyone. Deleting the last one must say so.
        if (body.annotations.length === 0 && meta.annotations.length > 0 && body.allowEmpty !== true) {
          await appendFile(join(STORE_DIR, 'telemetry.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'patch-blocked-empty', id, kept: meta.annotations.length }) + '\n').catch(() => {})
          body.annotations = meta.annotations
        }
        meta.annotations = body.annotations
          .slice(0, MAX_ANNOTATIONS)
          .map(normalizeAnnotation)
          .filter(Boolean)
      }
      if (body.code !== null && typeof body.code === 'object') meta.code = normalizeCode(body.code)
      meta.updatedAt = Date.now()
      await writeMeta(meta)
      if (Array.isArray(body.annotations) || Array.isArray(body.paperNotes)) await syncPaperNotes(meta)
      sendJson(res, 200, { ok: true, doc: summaryOf(meta) })
      return true
    }
    if (req.method === 'DELETE') {
      await unlink(pdfPath(id)).catch(() => {})
      await unlink(metaPath(id)).catch(() => {})
      await rm(join(STORE_DIR, `${id}.md`), { recursive: true, force: true }).catch(() => {})
      stopParse(id, 'deleted')
      sendJson(res, 200, { ok: true })
      return true
    }
    sendError(res, 405, 'method not allowed', 'method-error')
    return true
  }

  if (pathname === '/paper-reader/api/telemetry') {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const raw = (await readBody(req, 16 * 1024)).toString('utf8')
    let entry = null
    try { entry = JSON.parse(raw) } catch { entry = { raw: raw.slice(0, 400) } }
    await appendFile(join(STORE_DIR, 'telemetry.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n').catch(() => {})
    sendJson(res, 200, { ok: true })
    return true
  }

  if (pathname === '/paper-reader/api/version') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8').catch(() => '{}'))
    const version = typeof pkg.version === 'string' ? pkg.version : ''
    await appendFile(join(STORE_DIR, 'telemetry.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'version', version }) + '\n').catch(() => {})
    sendJson(res, 200, { ok: true, version })
    return true
  }

  if (pathname === '/paper-reader/api/skill') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    sendJson(res, 200, { ok: true, skill: { name: PAPER_SKILL_NAME, description: PAPER_SKILL_DESCRIPTION, content: PAPER_SKILL_BODY } })
    return true
  }

  if (pathname === '/paper-reader/api/settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, settings: publicSettings(await readSettings()) })
      return true
    }
    if (req.method === 'PATCH') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
      const next = await writeSettings(body)
      sendJson(res, 200, { ok: true, settings: publicSettings(next) })
      return true
    }
    sendError(res, 405, 'method not allowed', 'method-error')
    return true
  }

  if (pathname === '/paper-reader/api/parse') {
    const id = docId(url.searchParams.get('id'))
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    if (req.method === 'GET') {
      try {
        sendJson(res, 200, { ok: true, parse: await parseStateOf(id) })
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
      }
      return true
    }
    if (req.method === 'POST') {
      const engine = url.searchParams.get('engine') === 'mineru' ? 'mineru' : 'markdown'
      if (engine === 'mineru') {
        const settings = await readSettings()
        if (settings.mineruApiKey === '') {
          sendError(res, 400, 'MinerU API key is not configured', 'no-key')
          return true
        }
      }
      try {
        await stat(pdfPath(id))
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
        return true
      }
      sendJson(res, 202, { ok: true, parse: startParse(id, engine) })
      return true
    }
    sendError(res, 405, 'method not allowed', 'method-error')
    return true
  }

  if (pathname === '/paper-reader/api/paperdir') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const id = docId(url.searchParams.get('id'))
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    try {
      sendJson(res, 200, { ok: true, folder: await paperBrief(id) })
    } catch {
      sendError(res, 404, 'paper not found', 'not-found')
    }
    return true
  }

  if (pathname === '/paper-reader/api/code') {
    if (req.method === 'GET') {
      const id = docId(url.searchParams.get('id'))
      if (id === undefined) {
        sendError(res, 400, 'missing or invalid paper id', 'bad-id')
        return true
      }
      try {
        const meta = await readMeta(id)
        sendJson(res, 200, { ok: true, code: meta.code })
      } catch {
        sendError(res, 404, 'paper not found', 'not-found')
      }
      return true
    }
    if (req.method !== 'POST') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    let body
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
    } catch {
      sendError(res, 400, 'body must be JSON', 'bad-body')
      return true
    }
    const id = docId(body.id)
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    try {
      const action = typeof body.action === 'string' ? body.action : 'repo'
      if (action === 'clone') {
        const typed = typeof body.repo === 'string' ? body.repo.trim() : ''
        if (typed !== '') {
          const current = await readMeta(id)
          if (typed !== current.code.repo) {
            if (!/^https?:\/\//i.test(typed)) throw Object.assign(new Error('repo must be an http(s) URL'), { status: 400 })
            current.code = normalizeCode({ ...current.code, repo: typed, clone: { status: 'idle', message: '', startedAt: 0, finishedAt: 0 } })
            current.updatedAt = Date.now()
            await writeMeta(current)
          }
        }
        sendJson(res, 200, { ok: true, clone: await startClone(id), folder: await paperBrief(id) })
        return true
      }
      const meta = await readMeta(id)
      const repo = typeof body.repo === 'string' ? body.repo.trim() : meta.code.repo
      if (repo !== '' && !/^https?:\/\//i.test(repo)) throw Object.assign(new Error('repo must be an http(s) URL'), { status: 400 })
      const reset = repo !== meta.code.repo
      meta.code = normalizeCode({ ...meta.code, repo, clone: reset ? { status: 'idle', message: '', startedAt: 0, finishedAt: 0 } : meta.code.clone })
      meta.updatedAt = Date.now()
      await writeMeta(meta)
      sendJson(res, 200, { ok: true, folder: await paperBrief(id) })
    } catch (error) {
      sendError(res, Number.isInteger(error?.status) ? error.status : 500, error?.message ?? String(error), 'code-failed')
    }
    return true
  }

  if (pathname === '/paper-reader/api/tree') {
    if (req.method !== 'GET') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    try {
      sendJson(res, 200, { ok: true, listing: await listDirectory(url.searchParams.get('path') ?? '') })
    } catch (error) {
      sendError(res, Number.isInteger(error?.status) ? error.status : 400, error?.message ?? String(error), 'bad-path')
    }
    return true
  }

  if (pathname === '/paper-reader/file') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    const id = docId(url.searchParams.get('id'))
    if (id === undefined) {
      sendError(res, 400, 'missing or invalid paper id', 'bad-id')
      return true
    }
    let meta
    try {
      meta = await readMeta(id)
    } catch {
      sendError(res, 404, 'paper not found', 'not-found')
      return true
    }
    let info
    try {
      info = await stat(pdfPath(id))
    } catch {
      sendError(res, 404, 'paper file not found', 'not-found')
      return true
    }
    const encoded = encodeURIComponent(meta.fileName || `${meta.title}.pdf`)
    serveFile(req, res, pdfPath(id), info.size, 'application/pdf', {
      'content-disposition': `inline; filename*=UTF-8''${encoded}`,
    })
    return true
  }

  if (pathname.startsWith('/paper-reader/static/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'method not allowed', 'method-error')
      return true
    }
    let relative
    try {
      relative = decodeURIComponent(pathname.slice('/paper-reader/static/'.length))
    } catch {
      sendError(res, 400, 'bad path', 'bad-path')
      return true
    }
    const target = resolve(PUBLIC_DIR, relative)
    if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
      sendError(res, 403, 'forbidden', 'forbidden')
      return true
    }
    let info
    try {
      info = await stat(target)
    } catch {
      sendError(res, 404, 'not found', 'not-found')
      return true
    }
    if (!info.isFile()) {
      sendError(res, 404, 'not found', 'not-found')
      return true
    }
    serveFile(req, res, target, info.size, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream')
    return true
  }

  sendError(res, 404, 'unknown route', 'not-found')
  return true
}

// ── model-facing annotation tool ─────────────────────────────────────────────

const ANNOTATION_TOOL_DESCRIPTION = [
  "Read and write one paper's annotations, highlights and paper-level notes; they are the durable shared memory of what was read.",
  'action="list" without docId lists the library; with docId it returns that paper\'s paths (pdf / markdown / code), annotations and notes — call it first to see whether the paper was already read.',
  'action="search" looks for text across every paper\'s annotations and notes (pass docId to narrow it) — use it before reading to reuse what was already written.',
  'action="create" appends annotations, either one (page/text/note/kind) or a batch via items; text is the quoted passage, note is the judgement.',
  'action="update"/"delete" change one annotation by id; action="note"/"update_note"/"delete_note" manage paper-level notes (write one note per block — 论文简介 / 方法骨架 / 关键证据 / 正反辩论 / 怎么用 / 已读 — each with its title).',
  'action="code" reads or records the open-source repository; the checkout itself lands in the paper folder\'s remote/ through the reader UI.',
  'action="keywords" stores 3-6 domain keywords for the paper, shown on its library card; run it after reading.',
].join(' ')

function toolText(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 60000) }]
}

async function runAnnotationTool(args, exec) {
  const action = typeof args.action === 'string' ? args.action : 'list'
  if (action === 'list') {
    const id = docId(args.docId)
    if (id === undefined) {
      const docs = await listLibrary()
      return {
        ok: true,
        papers: docs.map((doc) => ({
          docId: doc.id,
          title: doc.title,
          pageCount: doc.pageCount,
          highlights: doc.highlightCount,
          notes: doc.noteCount,
          aiNotes: doc.aiCount,
          parseStatus: doc.parseStatus,
          keywords: doc.keywords,
        })),
      }
    }
    const meta = await readMeta(id)
    const page = Number.isInteger(args.page) ? args.page : 0
    const annotations = meta.annotations
      .filter((annotation) => page === 0 || annotation.page === page)
      .map((annotation) => ({
        id: annotation.id,
        page: annotation.page,
        kind: annotation.kind,
        author: annotation.author,
        text: annotation.text.slice(0, 2000),
        note: annotation.note.slice(0, 4000),

        createdAt: annotation.createdAt,
      }))
    const brief = await paperBrief(id)
    return {
      ok: true,
      docId: id,
      title: meta.title,
      pageCount: meta.pageCount,
      code: meta.code,
      keywords: meta.keywords,
      paths: brief === undefined ? null : { dir: brief.path, pdf: brief.pdf, markdown: brief.markdown, code: brief.code },
      annotations,
      notes: meta.paperNotes.map((note) => ({
        id: note.id,
        title: note.title,
        text: note.text,
        author: note.author,
        updatedAt: note.updatedAt,
      })),
    }
  }

  if (action === 'search') {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (query === '') throw Object.assign(new Error('search needs query'), { status: 400 })
    const id = docId(args.docId)
    const metas = id === undefined ? await Promise.all((await listLibrary()).map((doc) => readMeta(doc.id))) : [await readMeta(id)]
    const needle = query.toLowerCase()
    const hits = []
    for (const meta of metas) {
      for (const annotation of meta.annotations) {
        if ((annotation.text + '\n' + annotation.note).toLowerCase().includes(needle)) {
          hits.push({
            type: 'annotation',
            docId: meta.id,
            paperTitle: meta.title,
            id: annotation.id,
            page: annotation.page,
            kind: annotation.kind,
            author: annotation.author,
            text: annotation.text.slice(0, 400),
            note: annotation.note.slice(0, 600),
          })
        }
      }
      for (const note of meta.paperNotes) {
        if (note.text.toLowerCase().includes(needle)) {
          hits.push({
            type: 'note',
            docId: meta.id,
            paperTitle: meta.title,
            id: note.id,
            title: note.title,
            author: note.author,
            text: note.text.slice(0, 800),
          })
        }
      }
    }
    const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 60
    return { ok: true, query, total: hits.length, hits: hits.slice(0, limit) }
  }

  if (action === 'create') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('create needs a docId from action="list"'), { status: 400 })
    const items = Array.isArray(args.items) ? args.items : []
    const batch = items.length > 0 ? items : [{ page: args.page, text: args.text, note: args.note, kind: args.kind }]
    if (batch.length > 200) throw Object.assign(new Error(`create accepts at most ${MAX_ANNOTATIONS} items`), { status: 400 })
    const meta = await readMeta(id)
    const now = Date.now()
    const created = []
    const skipped = []
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index]
      if (item === null || typeof item !== 'object') {
        skipped.push({ index, reason: 'not an object' })
        continue
      }
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      const note = typeof item.note === 'string' ? item.note.trim() : ''
      if (text === '' && note === '') {
        skipped.push({ index, reason: 'needs text or note' })
        continue
      }
      if (meta.annotations.length >= MAX_ANNOTATIONS) {
        skipped.push({ index, reason: 'annotation limit reached' })
        continue
      }
      const page = Number.isInteger(item.page) && item.page > 0 ? Math.min(item.page, meta.pageCount ?? item.page) : 1
      const annotation = normalizeAnnotation({
        kind: item.kind === 'highlight' ? 'highlight' : 'note',
        page,
        text,
        note,
        color: '',
        author: 'ai',
        createdAt: now,
        updatedAt: now,
      })
      if (annotation === undefined) {
        skipped.push({ index, reason: 'could not be normalized' })
        continue
      }
      meta.annotations.push(annotation)
      created.push({ id: annotation.id, page: annotation.page, kind: annotation.kind, text: annotation.text.slice(0, 60) })
    }
    if (created.length === 0) {
      const reasons = skipped.map((entry) => `#${entry.index}: ${entry.reason}`).join('; ')
      throw Object.assign(new Error(`nothing created — ${reasons}`), { status: 400 })
    }
    meta.updatedAt = now
    await writeMeta(meta)
    await syncPaperNotes(meta)
    return { ok: true, docId: id, created, skipped }
  }

  if (action === 'note') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('note needs a docId'), { status: 400 })
    const text = typeof args.note === 'string' ? args.note.trim() : ''
    if (text === '') throw Object.assign(new Error('note needs note text'), { status: 400 })
    const meta = await readMeta(id)
    if (meta.paperNotes.length >= MAX_PAPER_NOTES) throw Object.assign(new Error('note limit reached'), { status: 409 })
    const now = Date.now()
    const note = normalizePaperNote({
      title: typeof args.title === 'string' ? args.title.trim() : '',
      text,
      author: 'ai',
      createdAt: now,
      updatedAt: now,
    })
    meta.paperNotes.push(note)
    meta.updatedAt = now
    await writeMeta(meta)
    await syncPaperNotes(meta)
    return { ok: true, docId: id, created: { id: note.id, text: note.text } }
  }

  if (action === 'update_note' || action === 'delete_note') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('needs a docId'), { status: 400 })
    const noteId = typeof args.id === 'string' ? args.id : ''
    const meta = await readMeta(id)
    const index = meta.paperNotes.findIndex((note) => note.id === noteId)
    if (index < 0) throw Object.assign(new Error(`no note ${noteId}`), { status: 404 })
    if (action === 'delete_note') {
      meta.paperNotes.splice(index, 1)
    } else {
      const text = typeof args.note === 'string' ? args.note.trim() : ''
      if (text === '') throw Object.assign(new Error('update_note needs note text'), { status: 400 })
      const title = typeof args.title === 'string' ? args.title.trim().slice(0, 48) : meta.paperNotes[index].title
      meta.paperNotes[index] = { ...meta.paperNotes[index], title, text: text.slice(0, MAX_NOTE_CHARS), updatedAt: Date.now() }
    }
    meta.updatedAt = Date.now()
    await writeMeta(meta)
    await syncPaperNotes(meta)
    return { ok: true, docId: id, notes: meta.paperNotes }
  }

  if (action === 'keywords') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('keywords needs a docId'), { status: 400 })
    const meta = await readMeta(id)
    const raw = Array.isArray(args.keywords) ? args.keywords : typeof args.keywords === 'string' ? args.keywords.split(/[,，、]/) : []
    const words = raw
      .filter((word) => typeof word === 'string')
      .map((word) => word.trim().slice(0, 24))
      .filter((word) => word !== '')
      .slice(0, 8)
    meta.keywords = words
    meta.updatedAt = Date.now()
    await writeMeta(meta)
    await paperBrief(id).catch(() => {})
    return { ok: true, docId: id, keywords: words }
  }

  if (action === 'code') {
    const id = docId(args.docId)
    if (id === undefined) throw Object.assign(new Error('code needs a docId'), { status: 400 })
    const meta = await readMeta(id)
    const repo = typeof args.repo === 'string' ? args.repo.trim() : ''
    if (repo === '') {
      return { ok: true, docId: id, title: meta.title, pageCount: meta.pageCount, code: meta.code }
    }
    if (!/^https?:\/\//i.test(repo)) {
      throw Object.assign(new Error('repo must be an http(s) URL'), { status: 400 })
    }
    const reset = repo !== meta.code.repo
    meta.code = normalizeCode({ ...meta.code, repo, clone: reset ? { status: 'idle', message: '', startedAt: 0, finishedAt: 0 } : meta.code.clone })
    meta.updatedAt = Date.now()
    await writeMeta(meta)
    await paperBrief(id).catch(() => {})
    return { ok: true, docId: id, title: meta.title, code: meta.code }
  }

  if (action === 'update' || action === 'delete') {
    const id = docId(args.docId)
    const annotationId = typeof args.id === 'string' ? args.id : ''
    if (id === undefined || annotationId === '') throw Object.assign(new Error(`${action} needs docId and id`), { status: 400 })
    const meta = await readMeta(id)
    const index = meta.annotations.findIndex((annotation) => annotation.id === annotationId)
    if (index === -1) throw Object.assign(new Error('annotation not found'), { status: 404 })
    if (action === 'delete') {
      meta.annotations.splice(index, 1)
    } else {
      const target = meta.annotations[index]
      if (typeof args.note === 'string') target.note = args.note.slice(0, 20000)
      if (typeof args.text === 'string' && args.text.trim() !== '') target.text = args.text.slice(0, 20000)
      target.updatedAt = Date.now()
    }
    meta.updatedAt = Date.now()
    await writeMeta(meta)
    await syncPaperNotes(meta)
    return { ok: true, docId: id, id: annotationId }
  }

  throw Object.assign(new Error(`unknown action: ${action}`), { status: 400 })
}

function registerAnnotationTool(ctx) {
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.get('tools')
    if (tools === undefined || typeof tools.register !== 'function') return
    const definition = {
      name: 'paper_annotations',
      description: ANNOTATION_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'search', 'create', 'update', 'delete', 'code', 'keywords', 'note', 'update_note', 'delete_note'],
            description: "list papers, one paper's annotations and its notes; create/update/delete an annotation; note/update_note/delete_note manage paper-level notes", 
          },
          docId: { type: 'string', description: 'paper id from action="list"' },
          query: { type: 'string', description: 'for action="search": case-insensitive text to look for in annotations and notes' },
          keywords: {
            type: 'array',
            description: 'for action="keywords": 3-6 domain keywords that place this paper in a field; replaces the stored list',
            items: { type: 'string' },
          },
          limit: { type: 'integer', description: 'for action="search": max hits, default 60' },
          id: { type: 'string', description: 'annotation id, for update/delete' },
          page: { type: 'integer', description: '1-based page number' },
          items: {
            type: 'array',
            description: 'for action="create": write several annotations in one call',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer', description: '1-based page number' },
                text: { type: 'string', description: 'the quoted passage, <=200 chars' },
                note: { type: 'string', description: 'your judgement on that passage, one sentence' },
                kind: { type: 'string', enum: ['note', 'highlight'] },
              },
              required: ['page'],
              additionalProperties: false,
            },
          },
          kind: { type: 'string', enum: ['note', 'highlight'], description: 'annotation kind, defaults to note' },
          repo: { type: 'string', description: 'for action="code": open-source repository URL of this paper\'s implementation' },
          text: { type: 'string', description: 'the quoted passage the annotation is about' },
          note: { type: 'string', description: 'the annotation body, or the paper-level note text, written in the user\'s language and kept to one sentence' },
          title: { type: 'string', description: 'for note/update_note: the block heading, e.g. 论文简介 / 方法骨架 / 关键证据 / 正反辩论 / 怎么用 / 已读' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            papers: { type: 'array', items: { type: 'object', additionalProperties: true } },
            annotations: { type: 'array', items: { type: 'object', additionalProperties: true } },
            created: { type: 'array', items: { type: 'object', additionalProperties: true } },
            skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
            hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          additionalProperties: true,
        },
        render: (_args, value) => toolText(value),
      },
      execute: (args, exec) => runAnnotationTool(args, exec),
    }
    try {
      toolCtx.effect(() => tools.register(definition))
    } catch (error) {
      // A deployment without the tools service still keeps every HTTP route.
      toolCtx.logger?.warn?.('paper_annotations tool not registered: %s', error?.message ?? error)
    }
  })
}

// ── the skill that teaches cross-session paper memory ────────────────────────

const PAPER_SKILL_NAME = 'dsh-paper-reading'

const PAPER_SKILL_DESCRIPTION = '读一篇论文并把它读成标注与笔记：已读判断、逐节标注、论文级大笔记的完整工作流。'

const PAPER_SKILL_BODY = `# 论文阅读：把读到的内容写进标注与笔记

每篇论文的工作目录固定这几样，先按目录读，不要凭记忆猜内容：

- \`meta.md\`：元信息——页数、领域关键词、开源仓库地址与克隆状态、解析状态、各目录内容计数。**必有**，先读它。
- \`notes.md\`：标注与笔记的唯一文档，按「## 笔记 / ## 标注」分块，每次改动自动重写。
- \`markdown/paper.md\`：解析正文，可能带 \`images/\`。
- \`remote/\`：克隆下来的开源实现，可能是空的。
- \`local/\`：本地复现代码（论文没开源、或自己想改一版时放这里），默认空。
- \`pdf/\`：原始 PDF。

\`paper_annotations (action="list", docId)\` 返回的 \`paths\` 指向这些位置。

## 一、先查已读，再决定读不读

1. \`list\`（不带 docId）：拿到这篇的 docId、页数、标注与笔记数量。
2. \`list\`（带 docId）：读全部 annotations、notes 与 paths。
   要找「以前在哪篇写过 X」：\`search\` + \`query\`（可带 docId 限定单篇），命中会给 docId、页码与原文。
3. 判定已读：notes 里有「已读」那条，且它覆盖了你要回答的章节与页码。
   - 已读且覆盖：直接用标注与笔记回答，附页码，**不重读**。
   - 只覆盖一部分：只补缺的章节，不从第一页重来。
   - 没读过：走下面的完整流程。

## 二、读

读 \`paths.markdown\`；没有 markdown 就提示用户在阅读器里点解析，或按 PDF 页读。
要看实现：先 \`ls remote/\`，空就看 \`local/\`；两边都空只说明还没人放代码，别当成论文没有实现。
按节推进：摘要 → 引言 → 方法 → 实验 → 局限与结论。**每节读完立刻落标注**，不要攒到最后一起写。
关键图（架构图、主结果、消融）在 \`markdown/images/\` 里，读到图所在小节时单独看一遍再标；公式与表格的数字直接引用原文。

## 三、标注：细节索引

每条锚在它说的那一页（PDF 页码，不是 markdown 行号）。
- \`text\`：原文引句，挑能自证的那句，不超过 200 字。
- \`note\`：你的判断，一句话、不超过 40 字，写「这说明了什么」，不写「作者写了什么」。
- \`kind\`：\`highlight\` 用于能选中的正文；\`note\` 用于页级观察（图表、页边结论）。
- 覆盖面：每节 1–3 条；方法的关键步骤、实验的关键数字与对照组必须有。
- 一条结论对应一条标注，不重复标同一处。

一次用 \`items\` 提交 5–10 条，比一条一调省往返。

不标：目录、致谢、纯背景铺垫、同一结论的重复表述。

## 四、大笔记：按块写，一篇论文一组

读完立刻写，**一块一条**（\`action="note"\`，\`title\` 填块名，正文不要再重复块名），六块齐全：

1. **【论文简介】** 解决什么问题、用什么方法、结论有多强（真机？大规模？单一任务？）。
2. **【方法骨架】** 3–5 步或模块，写清输入输出与依赖顺序；关键设计选择说清为什么这么做。
3. **【关键证据】** 支撑结论的实验与数字：对照对象、指标、提升幅度、失效条件。
4. **【正反辩论】** 2–4 组，每组三行：\`正方：…\` / \`反方：…\` / \`裁决：…\`。
   - 问题钉在具体设计或数字上，不写「方法是否通用」这类空话。
   - 反方要能扎人：指假设漏洞、实验缺失、隐性优势、替代解释。
   - 裁决给条件性结论：在什么条件下正方成立，什么条件下反方占优。
5. **【怎么用】** 可复用点、和当前工作的接口、需要自己验证的地方。
6. **【已读】** \`已读 p1-pN；覆盖 X 节；未读 附录\`——下次靠它判断要不要重读。

每条 2–5 句。大笔记不是摘要：写判断与取舍，让没读过的人也能据此行动。
标注与笔记都落进论文目录的 \`notes.md\`——那是这篇论文唯一的可读文档，别在别处再存一份。
同一篇论文只有这一组，不要写第二遍；有新认识就 \`update_note\` 改对应的那块。

## 五、关键词：让这篇论文可被认出

读完（标注与大笔记都落好）再跑一次 \`action="keywords"\`，\`keywords\` 给 3–6 个词：大领域 + 子方向 + 任务或数据名，例如 \`["VLA", "推理运行时", "Roofline", "机器人策略"]\`。
它直接显示在论文库卡片上，也是以后 \`search\` 之外找论文的入口。写完再回答用户。

## 六、回答

细节问题先查标注与大笔记，不够再回原文补。答案里带页码，用户在阅读器里能直接点过去。

## 不该做

- 只写 40 字的大笔记——大笔记要能撑起整篇判断。
- 每段都标（噪音），或标了却不写 note（等于没读）。
- 已覆盖的章节反复读、重复写。
`;

/** Advertise the cross-session memory skill from this plugin's own runtime. */
function registerPaperSkill(ctx) {
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => skillCtx.skills.register({
      name: PAPER_SKILL_NAME,
      description: PAPER_SKILL_DESCRIPTION,
      whenToUse: '读论文、写论文标注或笔记、跨会话接着上次的结论继续时',
      // A loaded skill requires a string source; the registry keeps the provider
      // label separate, so name the origin bucket explicitly.
      source: 'runtime',
      content: PAPER_SKILL_BODY,
    }))
  })
}

// ── plugin body ──────────────────────────────────────────────────────────────

export function apply(ctx) {
  const trustedHosts = ctx.webStartup.trustedHosts ?? []
  registerAnnotationTool(ctx)
  registerPaperSkill(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/paper-reader',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        await handleApi(req, res, url, (request) => isTrustedApiRequest(request, trustedHosts))
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500
        sendError(res, status, error?.message ?? String(error))
      }
    },
  }))
}
