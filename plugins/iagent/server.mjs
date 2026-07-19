#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const DEFAULT_PORT = 17372
const CONFIG_FILE = process.env.IAGENT_AGENT_CONFIG || path.join(os.homedir(), '.iagent', 'codex-agent.json')
const STUDIO_ORIGIN = process.env.IAGENT_STUDIO_ORIGIN || 'https://ai.iagent.dev'
const TOOL_TIMEOUT_MS = 60_000
const BRIDGE_SERVICE = 'iagent-codex-bridge'
let ownedBridgeServer = null
let shutdownRegistered = false

export const tools = [
  {
    name: 'iagent_studio_get_config',
    description: '读取 iAgent 创意工坊当前可用的 API Key（不返回密钥）、图片/视频模型和尺寸参数。生成前优先调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'iagent_generate_image',
    description: '在用户已登录的 iAgent 创意工坊中提交图片生成任务。返回 taskId，随后用 iagent_generation_get_status 查询。',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1 },
        keyId: { type: 'number' },
        model: { type: 'string' },
        sizeMode: { type: 'string', enum: ['preset', 'custom'], description: 'preset 使用画幅与清晰度；custom 使用精确像素宽高。两种模式互斥。' },
        size: { type: 'string', description: 'preset 模式使用 auto、比例（如 16:9）或预设画幅；custom 模式使用像素尺寸（如 2048x1152）。' },
        quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
        resolution: { type: 'string', enum: ['auto', '1K', '2K', '4K'], description: '仅 preset 模式使用；custom 模式必须为 auto 或省略。' },
        count: { type: 'number', minimum: 1, maximum: 4 }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'iagent_generate_video',
    description: '在用户已登录的 iAgent 创意工坊中提交视频生成任务。返回 taskId，随后用 iagent_generation_get_status 查询。',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1 },
        keyId: { type: 'number' },
        model: { type: 'string' },
        size: { type: 'string', description: 'auto、比例（如 16:9）或像素尺寸' },
        resolution: { type: 'string', enum: ['480p', '720p'] },
        duration: { type: 'number', minimum: 1, maximum: 15 }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'iagent_generation_get_status',
    description: '查询 iAgent 创意工坊生成任务。可传 taskId 查询单个任务，不传则返回最近任务。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { taskId: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 20 } }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'iagent_generation_stop',
    description: '停止指定的 iAgent 创意工坊生成任务。',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      additionalProperties: false,
      properties: { taskId: { type: 'string', minLength: 1 } }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }
]

function loadConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (typeof stored.url === 'string' && typeof stored.token === 'string') {
      return { url: stored.url, token: stored.token, origins: Array.isArray(stored.origins) ? stored.origins : [] }
    }
  } catch {}
  return { url: `http://127.0.0.1:${Number(process.env.IAGENT_AGENT_PORT) || DEFAULT_PORT}`, token: crypto.randomBytes(24).toString('hex'), origins: [] }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

function hasToken(req, url, token) {
  return url.searchParams.get('token') === token || req.headers['x-iagent-agent-token'] === token
}

function setCors(req, res, config, validToken) {
  const origin = req.headers.origin
  if (!origin) return true
  if (!validToken) return false
  if (!config.origins.includes(origin)) {
    config.origins.push(origin)
    saveConfig(config)
  }
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-iagent-agent-token')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  res.setHeader('Vary', 'Origin')
  return true
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 1024 * 1024) throw new Error('request body too large')
  }
  return body ? JSON.parse(body) : {}
}

function sendEvent(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function studioConnectionUrl(config) {
  const url = new URL('/app/images', STUDIO_ORIGIN)
  url.searchParams.set('agentUrl', config.url)
  url.searchParams.set('agentToken', config.token)
  return url.toString()
}

async function isBridgeAvailable(config) {
  try {
    const response = await fetch(`${config.url}/health`, {
      headers: { 'x-iagent-agent-token': config.token },
      signal: AbortSignal.timeout(1000)
    })
    const payload = await response.json().catch(() => null)
    return response.ok && payload?.service === BRIDGE_SERVICE
  } catch {
    return false
  }
}

async function findActiveBridgeConfig(inputConfig) {
  const candidates = [inputConfig, loadConfig()]
  const checked = new Set()
  for (const config of candidates) {
    const identity = `${config.url}\n${config.token}`
    if (checked.has(identity)) continue
    checked.add(identity)
    if (await isBridgeAvailable(config)) return config
  }
  return null
}

function retainBridgeServer(server) {
  if (!server) return
  ownedBridgeServer = server
  if (shutdownRegistered) return
  shutdownRegistered = true
  const close = () => {
    if (!ownedBridgeServer) return process.exit(0)
    ownedBridgeServer.close(() => process.exit(0))
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

export async function startBridgeServer(inputConfig = loadConfig()) {
  const config = inputConfig
  const clients = new Map()
  const pending = new Map()
  let activeClientId = ''

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', config.url)
    const validToken = hasToken(req, url, config.token)
    if (req.method === 'OPTIONS') {
      if (!setCors(req, res, config, validToken)) return json(res, 403, { ok: false, error: 'origin not allowed' })
      res.writeHead(204)
      return res.end()
    }
    if (req.method === 'GET' && url.pathname === '/connect') {
      res.writeHead(302, { Location: studioConnectionUrl(config), 'Cache-Control': 'no-store' })
      return res.end()
    }
    if (!validToken) return json(res, 401, { ok: false, error: 'invalid token' })
    if (url.pathname === '/health') return json(res, 200, { ok: true, service: BRIDGE_SERVICE, clients: clients.size })
    if (!setCors(req, res, config, true)) return json(res, 403, { ok: false, error: 'origin not allowed' })

    if (req.method === 'GET' && url.pathname === '/events') {
      const clientId = url.searchParams.get('clientId') || crypto.randomUUID()
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      clients.set(clientId, res)
      activeClientId = clientId
      sendEvent(res, 'hello', { ok: true, clientId })
      const heartbeat = setInterval(() => sendEvent(res, 'ping', { time: Date.now() }), 15_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        clients.delete(clientId)
        if (activeClientId === clientId) activeClientId = [...clients.keys()].at(-1) || ''
        for (const [requestId, item] of pending) {
          if (item.clientId !== clientId) continue
          clearTimeout(item.timer)
          pending.delete(requestId)
          item.reject(new Error('iAgent 浏览器已断开'))
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/tools') {
      try {
        const body = await readJson(req)
        const client = clients.get(activeClientId)
        if (!client) return json(res, 409, {
          ok: false,
          error: '当前没有已连接的 iAgent 浏览器',
          connectionUrl: connectionUrl(config)
        })
        const requestId = crypto.randomUUID()
        sendEvent(client, 'tool_call', { requestId, name: body.name, input: body.input || {} })
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId)
            reject(new Error('iAgent 浏览器工具执行超时'))
          }, TOOL_TIMEOUT_MS)
          pending.set(requestId, { clientId: activeClientId, resolve, reject, timer })
        })
        return json(res, 200, { ok: true, result })
      } catch (error) {
        return json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'tool call failed' })
      }
    }

    if (req.method === 'POST' && url.pathname === '/result') {
      try {
        const body = await readJson(req)
        const item = pending.get(String(body.requestId || ''))
        if (!item) return json(res, 409, { ok: false, error: 'tool request not found' })
        pending.delete(body.requestId)
        clearTimeout(item.timer)
        body.error ? item.reject(new Error(String(body.error))) : item.resolve(body.result)
        return json(res, 200, { ok: true })
      } catch (error) {
        return json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid result' })
      }
    }

    return json(res, 404, { ok: false, error: 'not found' })
  })

  const configuredPort = process.env.IAGENT_AGENT_PORT === undefined ? Number(new URL(config.url).port) || DEFAULT_PORT : Number(process.env.IAGENT_AGENT_PORT)
  const requestedPort = Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : DEFAULT_PORT
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : requestedPort
  config.url = `http://127.0.0.1:${port}`
  saveConfig(config)
  return { server, config }
}

export async function ensureBridgeServer(inputConfig = loadConfig()) {
  const activeConfig = await findActiveBridgeConfig(inputConfig)
  if (activeConfig) return { server: null, config: activeConfig, reused: true }
  try {
    const bridge = await startBridgeServer(inputConfig)
    return { ...bridge, reused: false }
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      for (let attempt = 0; attempt < 10; attempt++) {
        const competingConfig = await findActiveBridgeConfig(inputConfig)
        if (competingConfig) return { server: null, config: competingConfig, reused: true }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw error
  }
}

async function callBrowserTool(config, name, input) {
  const bridge = await ensureBridgeServer(config)
  retainBridgeServer(bridge.server)
  const response = await fetch(`${bridge.config.url}/api/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-iagent-agent-token': bridge.config.token },
    body: JSON.stringify({ name, input })
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok) {
    const message = payload?.connectionUrl ? `${payload.error}\n连接地址：${payload.connectionUrl}` : payload?.error
    throw new Error(message || `iAgent bridge request failed (${response.status})`)
  }
  return payload.result
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

export function startMcpServer(config) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', async (line) => {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      return
    }
    if (!('id' in request)) return
    const base = { jsonrpc: '2.0', id: request.id }
    try {
      if (request.method === 'initialize') {
        return writeMessage({ ...base, result: { protocolVersion: request.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'iagent', version: '0.1.0' }, instructions: '先用 iagent_studio_get_config 获取可用模型和参数，再提交图片或视频任务；生成任务是异步的，用 iagent_generation_get_status 查询。' } })
      }
      if (request.method === 'ping') return writeMessage({ ...base, result: {} })
      if (request.method === 'tools/list') return writeMessage({ ...base, result: { tools } })
      if (request.method === 'tools/call') {
        const name = String(request.params?.name || '')
        if (!tools.some((tool) => tool.name === name)) throw new Error(`unknown tool: ${name}`)
        try {
          const result = await callBrowserTool(config, name, request.params?.arguments || {})
          return writeMessage({ ...base, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } })
        } catch (error) {
          return writeMessage({ ...base, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'tool call failed' }] } })
        }
      }
      writeMessage({ ...base, error: { code: -32601, message: `method not found: ${request.method}` } })
    } catch (error) {
      writeMessage({ ...base, error: { code: -32603, message: error instanceof Error ? error.message : 'internal error' } })
    }
  })
}

export function connectionUrl(config = loadConfig()) {
  return new URL('/connect', config.url).toString()
}

async function main() {
  const mode = process.argv[2] || 'mcp'
  if (mode === 'url') {
    process.stdout.write(`${connectionUrl()}\n`)
    return
  }
  if (mode !== 'mcp') throw new Error(`unknown mode: ${mode}`)
  const { server, config, reused } = await ensureBridgeServer()
  process.stderr.write(`iAgent bridge ${reused ? 'reused at' : 'listening on'} ${config.url}\n`)
  retainBridgeServer(server)
  startMcpServer(config)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exit(1)
  })
}
