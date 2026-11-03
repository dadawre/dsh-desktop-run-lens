/**
 * 运行透视（Run Lens）— DSH Desktop 工作台服务端插件。
 *
 * 只读读取会话的事件日志（SessionEvent），聚合成「回合 → 步骤 → 工具调用」的运行快照。
 * - GET /api/dsh-desktop-run-lens/snapshot?sessionId=<id>：紧凑摘要，供面板高频轮询；
 * - GET /api/dsh-desktop-run-lens/detail?sessionId=<id>&turn=&step=：按需返回完整文本/参数/返回。
 * 面板只在用户点开某一步时才加载完整内容，避免每次轮询传输全量长文本。
 *
 * 设计约束：
 * - 不静态导入任何 @deepseek-ai 包（profile 的 node_modules 里没有这些包，静态 ESM 导入会解析失败）；
 * - 不导出 Config，避免引入 schemastery；不写业务数据，不修改会话，不激活 Agent；
 * - 事件载荷在 event.data 下，时间戳是 event.time（纪元毫秒）。
 */

const API_PATH = '/api/dsh-desktop-run-lens/snapshot'
const DETAIL_PATH = '/api/dsh-desktop-run-lens/detail'
const SUBAGENTS_PATH = '/api/dsh-desktop-run-lens/subagents'
const OWNER_ID = 'local:dsh-desktop-run-lens'

/* 快照只保留便于扫描的摘要；完整内容走 detail 接口（MAX_FULL 为单字段安全上限）。 */
const MAX_TEXT = 1400
const MAX_REASONING = 400
const MAX_ARGS = 320
const MAX_RESULT = 320
const MAX_META = 200
const MAX_DETAIL = 240
const MAX_FULL = 200000
const MAX_SUBAGENTS = 32
const MAX_PERSISTED_EVENTS = 60000

export const name = 'dsh-desktop-run-lens'
export const inject = ['connection']

export function apply(ctx) {
  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => readSnapshot(ctx, request)
  })
  ctx.connection.fetch.register({
    path: DETAIL_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => readDetail(ctx, request)
  })
  ctx.connection.fetch.register({
    path: SUBAGENTS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => readSubagents(ctx, request)
  })
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function readSnapshot(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = String(url.searchParams.get('sessionId') ?? '').trim()
    if (!sessionId) return failure(400, '缺少 sessionId 参数。')

    const owner = await ownerOf(ctx, sessionId)
    if (owner !== null && owner !== OWNER_ID) {
      return failure(403, '这个会话属于其他工作台。请先在本工作台里开始或继续对话，再查看运行记录。')
    }

    const opened = await openSession(ctx, sessionId)
    if (!opened) return failure(404, '没有找到这个会话的运行记录。')

    return json(summarize(sessionId, opened.header, opened.events))
  } catch (error) {
    return failure(500, `读取运行记录失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readDetail(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = String(url.searchParams.get('sessionId') ?? '').trim()
    if (!sessionId) return failure(400, '缺少 sessionId 参数。')
    const turnNumber = numberOr(url.searchParams.get('turn'), Number.NaN)
    const stepNumber = numberOr(url.searchParams.get('step'), Number.NaN)
    if (!Number.isFinite(turnNumber) || !Number.isFinite(stepNumber)) {
      return failure(400, '缺少 turn 或 step 参数。')
    }

    const owner = await ownerOf(ctx, sessionId)
    if (owner !== null && owner !== OWNER_ID) {
      return failure(403, '这个会话属于其他工作台。请先在本工作台里开始或继续对话，再查看运行记录。')
    }

    const opened = await openSession(ctx, sessionId)
    if (!opened) return failure(404, '没有找到这个会话的运行记录。')

    const detail = extractDetail(opened.events, turnNumber, stepNumber)
    if (!detail) return failure(404, '没有找到这个步骤的详细内容。')
    return json({ ok: true, sessionId, turn: turnNumber, step: stepNumber, detail })
  } catch (error) {
    return failure(500, `读取步骤详情失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readSubagents(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = String(url.searchParams.get('sessionId') ?? '').trim()
    if (!sessionId) return failure(400, '缺少 sessionId 参数。')

    const owner = await ownerOf(ctx, sessionId)
    if (owner !== null && owner !== OWNER_ID) {
      return failure(403, '这个会话属于其他工作台。请先在本工作台里开始或继续对话，再查看运行记录。')
    }

    const opened = await openSession(ctx, sessionId)
    if (!opened) return failure(404, '没有找到这个会话的运行记录。')

    const discovered = await discoverSubagents(ctx, sessionId)
    const links = scanSubagentLinks(opened.events, discovered)
    const subagents = []
    for (const entry of discovered) {
      if (subagents.length >= MAX_SUBAGENTS) break
      const child = await openSession(ctx, entry.id)
      const summary = child ? summarizeMeta(entry.id, child.header, child.events) : null
      subagents.push({
        id: entry.id,
        parentId: entry.parentId,
        depth: entry.depth,
        mode: entry.mode,
        label: entry.label,
        hasChildren: entry.hasChildren,
        activity: entry.activity === 'running' || (summary && summary.running) ? 'running' : 'inactive',
        createdAt: entry.createdAt ?? (summary ? summary.createdAt : null),
        summary
      })
    }

    return json({
      ok: true,
      sessionId,
      generatedAt: Date.now(),
      truncated: discovered.length > MAX_SUBAGENTS,
      links,
      subagents
    })
  } catch (error) {
    return failure(500, `读取子代理记录失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function extractDetail(events, turnNumber, stepNumber) {
  const detail = {
    text: '',
    reasoning: '',
    interrupted: false,
    request: null,
    usage: null,
    stream: null,
    userText: '',
    tools: []
  }
  const tools = new Map()
  let lastUserText = ''
  let lastToolKey = ''
  let currentTurn = -1
  let currentStep = -1
  let found = false

  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const type = typeof raw.type === 'string' ? raw.type : ''
    const data = raw.data && typeof raw.data === 'object' ? raw.data : {}

    if (type === 'user/message') {
      const text = fullTextOf(textOf(data.content ?? data.message?.content ?? data.text))
      if (text) lastUserText = text
      continue
    }

    const eventTurn = numberOr(data.turn, -1)
    const eventStep = numberOr(data.step, -1)
    if (type === 'turn/start' && eventTurn === turnNumber && !detail.userText) {
      detail.userText = lastUserText
      continue
    }
    if (eventTurn >= 0) {
      currentTurn = eventTurn
      if (eventStep >= 0) currentStep = eventStep
    }
    if (type === 'request/header' && currentTurn === turnNumber && currentStep === stepNumber) {
      found = true
      const callHeader = data.header && typeof data.header === 'object' ? data.header : null
      const config = callHeader && callHeader.config && typeof callHeader.config === 'object' ? callHeader.config : null
      if (config) {
        detail.request = {
          provider: providerLabel(config.provider),
          model: typeof config.model === 'string' ? config.model : null,
          contextWindow: numericOrNull(config.contextWindow),
          tools: Array.isArray(callHeader.tools) ? callHeader.tools.length : null,
          reason: typeof data.reason === 'string' ? data.reason : null
        }
      }
      continue
    }
    if (type === 'request/context' && currentTurn === turnNumber && currentStep === stepNumber) {
      found = true
      const provider = providerLabel(data.provider)
      const model = typeof data.model === 'string' ? data.model : null
      if (model) {
        detail.request = {
          provider,
          model,
          contextWindow: numericOrNull(data.contextWindow),
          tools: detail.request && typeof detail.request.tools === 'number' ? detail.request.tools : null,
          reason: detail.request && typeof detail.request.reason === 'string' ? detail.request.reason : null
        }
      }
      continue
    }
    if (eventTurn !== turnNumber || eventStep !== stepNumber) continue
    found = true

    switch (type) {
      case 'assistant/message': {
        if (data.interrupted === true) detail.interrupted = true
        if (data.usage && typeof data.usage === 'object') {
          if (!detail.usage) detail.usage = emptyUsage()
          accumulateUsage(detail.usage, data.usage)
        }
        const message = data.message && typeof data.message === 'object' ? data.message : null
        const text = fullTextOf(assistantText(message) || streamText(data.stream))
        if (text) detail.text = text
        const reasoning = fullTextOf(assistantReasoning(message) || streamReasoning(data.stream))
        if (reasoning) detail.reasoning = reasoning
        detail.stream = summarizeStream(data.stream) ?? detail.stream
        break
      }

      case 'request/header': {
        const callHeader = data.header && typeof data.header === 'object' ? data.header : null
        const config = callHeader && callHeader.config && typeof callHeader.config === 'object' ? callHeader.config : null
        if (config) {
          detail.request = {
            provider: providerLabel(config.provider),
            model: typeof config.model === 'string' ? config.model : null,
            contextWindow: numericOrNull(config.contextWindow),
            tools: Array.isArray(callHeader.tools) ? callHeader.tools.length : null,
            reason: typeof data.reason === 'string' ? data.reason : null
          }
        }
        break
      }

      case 'request/context': {
        const provider = providerLabel(data.provider)
        const model = typeof data.model === 'string' ? data.model : null
        if (model) {
          detail.request = {
            provider,
            model,
            contextWindow: numericOrNull(data.contextWindow),
            tools: detail.request && typeof detail.request.tools === 'number' ? detail.request.tools : null,
            reason: detail.request && typeof detail.request.reason === 'string' ? detail.request.reason : null
          }
        }
        break
      }

      case 'tool/call': {
        const callId = typeof data.callId === 'string' && data.callId ? data.callId : ''
        const tool = {
          callId,
          name: typeof data.name === 'string' && data.name ? data.name : '未知工具',
          arguments: fullJsonOf(data.arguments),
          resultText: '',
          isError: false,
          error: null,
          meta: ''
        }
        const toolKey = callId || `tool-${tools.size + 1}`
        tools.set(toolKey, tool)
        lastToolKey = toolKey
        break
      }

      case 'tool/result': {
        const message = data.message && typeof data.message === 'object' ? data.message : null
        const explicitCallId =
          typeof message?.toolCallId === 'string'
            ? message.toolCallId
            : typeof data.callId === 'string'
              ? data.callId
              : ''
        const callId = explicitCallId || lastToolKey
        let tool = callId ? tools.get(callId) : undefined
        if (!tool) {
          tool = { callId, name: '工具结果', arguments: '', resultText: '', isError: false, error: null, meta: '' }
          tools.set(callId || `tool-${tools.size + 1}`, tool)
        }
        tool.resultText = fullTextOf(textOf(message?.content ?? message?.text ?? data.content))
        tool.isError = message?.isError === true || (data.error !== undefined && data.error !== null)
        tool.error =
          data.error && typeof data.error === 'object'
            ? {
                name: textOrNull(data.error.name),
                code: textOrNull(data.error.code),
                reason: textOrNull(data.error.reason)
              }
            : null
        tool.meta = fullJsonOf(data.meta)
        break
      }

      default:
        break
    }
  }

  if (!found) return null
  detail.tools = Array.from(tools.values())
  return detail
}

async function openSession(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  if (sessions && typeof sessions.get === 'function') {
    let session
    try {
      session = sessions.get(sessionId)
    } catch {
      session = undefined
    }
    if (session && typeof session.snapshotEvents === 'function') {
      try {
        const events = session.snapshotEvents()
        if (Array.isArray(events)) return { header: session.header ?? null, events }
      } catch {
        // 活跃会话读取失败时退回持久化检查。
      }
    }
  }

  const persisted = await readPersistedSession(ctx, sessionId)
  if (persisted) return persisted

  const controller = serviceOf(ctx, 'sessionController')
  if (controller && typeof controller.inspect === 'function') {
    try {
      const inspection = await controller.inspect(sessionId)
      if (inspection && Array.isArray(inspection.events)) {
        return { header: inspection.meta ?? null, events: inspection.events }
      }
    } catch {
      // 未知会话 / 已删除会话：返回 404。
    }
  }
  return null
}

/**
 * 从持久化存储直接打开任意已存会话（含子代理会话与冷主会话）。
 * 活跃会话已在上面通过 sessions 服务读取，这里覆盖其余情况。
 */
async function readPersistedSession(ctx, sessionId) {
  const persistence = serviceOf(ctx, 'sessionPersistence')
  if (!persistence || typeof persistence.open !== 'function') return null
  let handle = null
  try {
    handle = await persistence.open(sessionId, 'read')
    const events = []
    const pageSize = 400
    let offset = 0
    for (;;) {
      const page = await handle.read(offset, pageSize)
      const batch = page && Array.isArray(page.events) ? page.events : []
      if (batch.length === 0) break
      for (const event of batch) events.push(event)
      offset += batch.length
      if (batch.length < pageSize) break
      if (events.length > MAX_PERSISTED_EVENTS) break
    }
    return { header: handle.header ?? null, events }
  } catch {
    return null
  } finally {
    if (handle && typeof handle.close === 'function') {
      try {
        await handle.close()
      } catch {
        // 关闭失败不影响已读结果。
      }
    }
  }
}

async function ownerOf(ctx, sessionId) {
  const ownership = serviceOf(ctx, 'desktopWorkbenchOwnership')
  if (!ownership || typeof ownership.read !== 'function') return null
  try {
    const state = await ownership.read()
    const bindings = state && typeof state === 'object' ? state.sessionBindings : null
    if (!bindings || typeof bindings !== 'object') return null
    const owner = bindings[sessionId]
    return typeof owner === 'string' && owner ? owner : null
  } catch {
    return null
  }
}

function serviceOf(ctx, name) {
  let value
  try {
    value = ctx.get(name)
  } catch {
    value = undefined
  }
  if (value !== undefined) return value
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  })
}

function failure(status, message) {
  return json({ ok: false, error: message }, status)
}

/* ------------------------------------------------------------------ */
/* 聚合                                                                */
/* ------------------------------------------------------------------ */

function summarize(sessionId, header, events) {
  const now = Date.now()
  const turns = []
  const turnByNumber = new Map()
  const steps = new Map()
  const tools = new Map()
  const state = {
    lastUserText: '',
    firstEventTime: null,
    lastEventTime: null,
    lastSeq: null,
    model: null,
    contextWindow: null,
    errors: 0,
    toolCalls: 0,
    attempts: 0
  }

  function ensureTurn(turnNumber, eventTime) {
    let turn = turnByNumber.get(turnNumber)
    if (!turn) {
      turn = {
        turn: turnNumber,
        startedAt: eventTime,
        endedAt: null,
        open: true,
        reason: null,
        userText: state.lastUserText,
        usage: emptyUsage(),
        steps: []
      }
      turnByNumber.set(turnNumber, turn)
      turns.push(turn)
    }
    return turn
  }

  function ensureStep(turnNumber, stepNumber, eventTime) {
    const key = `${turnNumber}:${stepNumber}`
    let step = steps.get(key)
    if (!step) {
      const turn = ensureTurn(turnNumber, eventTime)
      step = {
        id: key,
        turn: turnNumber,
        step: stepNumber,
        startedAt: eventTime,
        endedAt: null,
        open: true,
        messageAt: null,
        usage: null,
        attempts: 0,
        requests: 0,
        request: null,
        stream: null,
        text: '',
        textTruncated: false,
        reasoning: '',
        reasoningTruncated: false,
        interrupted: false,
        toolCalls: []
      }
      steps.set(key, step)
      turn.steps.push(step)
    }
    return step
  }

  function stepOf(turnNumber, stepNumber) {
    return steps.get(`${turnNumber}:${stepNumber}`) ?? null
  }

  function latestStep() {
    let found = null
    for (const step of steps.values()) found = step
    return found
  }

  /** request/header 与 request/context 事件本身不带 turn/step，挂到当前最近步骤，避免造出 0:0 幽灵步骤。 */
  function stepForContext(turnNumber, stepNumber, eventTime) {
    const existing = stepOf(turnNumber, stepNumber)
    if (existing) return existing
    if (turnNumber > 0) return ensureStep(turnNumber, stepNumber, eventTime)
    return latestStep()
  }

  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const type = typeof raw.type === 'string' ? raw.type : ''
    const data = raw.data && typeof raw.data === 'object' ? raw.data : {}
    const eventTime = typeof raw.time === 'number' && Number.isFinite(raw.time) ? raw.time : now

    if (state.firstEventTime === null) state.firstEventTime = eventTime
    state.lastEventTime = eventTime
    if (typeof raw.seq === 'number') state.lastSeq = raw.seq
    else if (typeof raw.seq === 'string') state.lastSeq = raw.seq

    const turnNumber = numberOr(data.turn, 0)
    const stepNumber = numberOr(data.step, 0)

    switch (type) {
      case 'user/message': {
        const text = cutText(textOf(data.content ?? data.message?.content ?? data.text), MAX_TEXT)
        if (text.text) {
          state.lastUserText = text.text
          for (let index = turns.length - 1; index >= 0; index -= 1) {
            const turn = turns[index]
            if (turn.endedAt === null) {
              turn.userText = text.text
              break
            }
            break
          }
        }
        break
      }

      case 'turn/start': {
        const turn = ensureTurn(turnNumber, eventTime)
        if (turn.startedAt > eventTime) turn.startedAt = eventTime
        break
      }

      case 'turn/end': {
        const turn = ensureTurn(turnNumber, eventTime)
        turn.endedAt = eventTime
        turn.open = false
        turn.reason = describeTurnReason(data.reason)
        if (turn.reason && turn.reason.kind === 'error') state.errors += 1
        break
      }

      case 'step/start': {
        ensureStep(turnNumber, stepNumber, eventTime)
        break
      }

      case 'step/end': {
        const step = stepOf(turnNumber, stepNumber) ?? ensureStep(turnNumber, stepNumber, eventTime)
        step.endedAt = eventTime
        step.open = false
        break
      }

      case 'request/header': {
        const step = stepForContext(turnNumber, stepNumber, eventTime)
        if (!step) break
        step.requests += 1
        const callHeader = data.header && typeof data.header === 'object' ? data.header : null
        const config = callHeader && callHeader.config && typeof callHeader.config === 'object' ? callHeader.config : null
        if (config) {
          const provider = providerLabel(config.provider)
          const model = typeof config.model === 'string' ? config.model : null
          const contextWindow = numericOrNull(config.contextWindow)
          step.request = {
            provider,
            model,
            contextWindow,
            tools: Array.isArray(callHeader.tools) ? callHeader.tools.length : null,
            reason: typeof data.reason === 'string' ? data.reason : null
          }
          if (model) state.model = { provider, model }
          if (contextWindow !== null) state.contextWindow = contextWindow
        }
        break
      }

      case 'request/context': {
        const step = stepForContext(turnNumber, stepNumber, eventTime)
        if (!step) break
        const provider = providerLabel(data.provider)
        const model = typeof data.model === 'string' ? data.model : null
        const contextWindow = numericOrNull(data.contextWindow)
        if (model) {
          state.model = { provider, model }
          step.request = {
            provider,
            model,
            contextWindow,
            tools: step.request && typeof step.request.tools === 'number' ? step.request.tools : null,
            reason: step.request && typeof step.request.reason === 'string' ? step.request.reason : null
          }
        }
        if (contextWindow !== null) state.contextWindow = contextWindow
        break
      }

      case 'assistant/attempt': {
        const step = ensureStep(turnNumber, stepNumber, eventTime)
        step.attempts += 1
        state.attempts += 1
        break
      }

      case 'assistant/message': {
        const step = ensureStep(turnNumber, stepNumber, eventTime)
        step.messageAt = eventTime
        if (data.interrupted === true) step.interrupted = true
        if (data.usage && typeof data.usage === 'object') {
          if (!step.usage) step.usage = emptyUsage()
          accumulateUsage(step.usage, data.usage)
        }
        const message = data.message && typeof data.message === 'object' ? data.message : null
        const text = cutText(assistantText(message) || streamText(data.stream), MAX_TEXT)
        if (text.text) {
          step.text = text.text
          step.textTruncated = text.truncated
        }
        const reasoning = cutText(assistantReasoning(message) || streamReasoning(data.stream), MAX_REASONING)
        if (reasoning.text) {
          step.reasoning = reasoning.text
          step.reasoningTruncated = reasoning.truncated
        }
        step.stream = summarizeStream(data.stream)
        break
      }

      case 'tool/call': {
        const step = ensureStep(turnNumber, stepNumber, eventTime)
        const callId = typeof data.callId === 'string' && data.callId ? data.callId : `call-${state.toolCalls + 1}`
        const name = typeof data.name === 'string' && data.name ? data.name : '未知工具'
        const args = jsonPreview(data.arguments, MAX_ARGS)
        const tool = {
          callId,
          name,
          arguments: args.text,
          argumentsTruncated: args.truncated,
          startedAt: eventTime,
          resultAt: null,
          open: true,
          resultText: '',
          resultTruncated: false,
          isError: false,
          error: null,
          meta: ''
        }
        state.toolCalls += 1
        step.toolCalls.push(tool)
        tools.set(callId, tool)
        break
      }

      case 'tool/result': {
        const message = data.message && typeof data.message === 'object' ? data.message : null
        const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : typeof data.callId === 'string' ? data.callId : ''
        let tool = callId ? tools.get(callId) : undefined
        if (!tool) {
          const step = ensureStep(turnNumber, stepNumber, eventTime)
          tool = {
            callId: callId || `result-${state.toolCalls + 1}`,
            name: '工具结果',
            arguments: '',
            argumentsTruncated: false,
            startedAt: eventTime,
            resultAt: eventTime,
            open: false,
            resultText: '',
            resultTruncated: false,
            isError: false,
            error: null,
            meta: ''
          }
          step.toolCalls.push(tool)
          tools.set(tool.callId, tool)
        }
        tool.resultAt = eventTime
        tool.open = false
        const result = cutText(textOf(message?.content ?? message?.text ?? data.content), MAX_RESULT)
        tool.resultText = result.text
        tool.resultTruncated = result.truncated
        tool.isError = message?.isError === true || (data.error !== undefined && data.error !== null)
        if (data.error && typeof data.error === 'object') {
          tool.error = {
            name: textOrNull(data.error.name),
            code: textOrNull(data.error.code),
            reason: textOrNull(data.error.reason)
          }
          tool.isError = true
        } else {
          tool.error = null
        }
        const meta = jsonPreview(data.meta, MAX_META)
        tool.meta = meta.text
        if (tool.isError) state.errors += 1
        break
      }

      default:
        break
    }
  }

  const lastEventTime = state.lastEventTime === null ? now : state.lastEventTime
  const totals = emptyUsage()
  totals.turns = turns.length
  totals.steps = steps.size
  totals.toolCalls = state.toolCalls
  totals.errors = state.errors
  totals.attempts = state.attempts

  for (const turn of turns) {
    turn.open = turn.endedAt === null
    for (const step of turn.steps) {
      if (step.usage) accumulateUsage(turn.usage, step.usage)
      step.open = step.endedAt === null
      step.durationMs = Math.max(0, (step.endedAt ?? lastEventTime) - step.startedAt)
      step.modelMs = step.messageAt === null ? null : Math.max(0, step.messageAt - step.startedAt)
      if (step.stream) {
        step.firstTokenMs = step.stream.epoch ? Math.max(0, step.stream.firstAt - step.startedAt) : null
        step.streamMs = Math.max(0, step.stream.lastAt - step.stream.firstAt)
      } else {
        step.firstTokenMs = null
        step.streamMs = null
      }
      let toolMs = 0
      for (const tool of step.toolCalls) {
        tool.open = tool.resultAt === null
        tool.durationMs = tool.resultAt === null ? null : Math.max(0, tool.resultAt - tool.startedAt)
        if (tool.durationMs !== null) toolMs += tool.durationMs
      }
      step.toolMs = toolMs
    }
    accumulateUsage(totals, turn.usage)
    turn.durationMs = Math.max(0, (turn.endedAt ?? lastEventTime) - turn.startedAt)
  }

  totals.durationMs = 0
  for (const turn of turns) totals.durationMs += turn.durationMs

  const model = state.model || (state.contextWindow !== null ? { provider: null, model: null } : null)

  return {
    ok: true,
    generatedAt: now,
    session: {
      id: sessionId,
      cwd: header && typeof header.cwd === 'string' ? header.cwd : null,
      createdAt: header && typeof header.createdAt === 'number' ? header.createdAt : null,
      parentSession:
        header && typeof header === 'object' && typeof header.parentSession === 'string' ? header.parentSession : null,
      origin: header && typeof header === 'object' && typeof header.origin === 'string' ? header.origin : null,
      delegationDepth:
        header && typeof header === 'object' && typeof header.delegationDepth === 'number'
          ? header.delegationDepth
          : null,
      running: Boolean(turns.length > 0 && turns[turns.length - 1].open),
      eventCount: events.length,
      lastSeq: state.lastSeq,
      startedAt: state.firstEventTime,
      lastEventTime
    },
    model: model ? { provider: model.provider ?? null, model: model.model ?? null, contextWindow: state.contextWindow } : null,
    totals,
    turns
  }
}

/* ------------------------------------------------------------------ */
/* 子代理                                                              */
/* ------------------------------------------------------------------ */

async function discoverSubagents(ctx, sessionId) {
  const service = serviceOf(ctx, 'subagents')
  if (service && typeof service.listDescendants === 'function') {
    try {
      const rows = await service.listDescendants(sessionId)
      if (Array.isArray(rows)) {
        const entries = []
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue
          if (row.kind !== 'child') continue
          if (typeof row.id !== 'string' || !row.id) continue
          entries.push({
            id: row.id,
            parentId: typeof row.parentId === 'string' && row.parentId ? row.parentId : sessionId,
            depth: Math.max(1, numberOr(row.depth, 1)),
            mode: typeof row.mode === 'string' && row.mode ? row.mode : 'unknown',
            label: typeof row.label === 'string' ? row.label : '',
            hasChildren: row.hasChildren === true,
            activity: row.activity === 'running' ? 'running' : 'inactive'
          })
        }
        if (entries.length > 0) return sortSubagents(entries)
      }
    } catch {
      // 子代理投影不可用时退回持久化/活动会话扫描。
    }
  }
  return sortSubagents(await discoverSubagentsFallback(ctx, sessionId))
}

async function discoverSubagentsFallback(ctx, sessionId) {
  const entries = []
  const seen = new Set()

  const persistence = serviceOf(ctx, 'sessionPersistence')
  if (persistence && typeof persistence.list === 'function') {
    try {
      const snapshots = await persistence.list()
      if (Array.isArray(snapshots)) {
        const byParent = new Map()
        for (const snapshot of snapshots) {
          const header = snapshot && typeof snapshot === 'object' ? snapshot.header : null
          if (!header || typeof header !== 'object') continue
          const id = typeof header.id === 'string' ? header.id : ''
          const parent = typeof header.parentSession === 'string' ? header.parentSession : ''
          if (!id || !parent) continue
          if (header.origin !== 'subagent' && numberOr(header.delegationDepth, 0) < 1) continue
          if (!byParent.has(parent)) byParent.set(parent, [])
          byParent.get(parent).push({
            id,
            parentId: parent,
            createdAt: numberOr(header.createdAt, null)
          })
        }
        const queue = [sessionId]
        while (queue.length > 0) {
          const parentId = queue.shift()
          for (const child of byParent.get(parentId) || []) {
            if (seen.has(child.id)) continue
            seen.add(child.id)
            entries.push({
              id: child.id,
              parentId,
              depth: 1,
              mode: 'unknown',
              label: '',
              hasChildren: (byParent.get(child.id) || []).length > 0,
              activity: 'inactive',
              createdAt: child.createdAt
            })
            queue.push(child.id)
          }
        }
      }
    } catch {
      // 忽略持久化读取失败，继续尝试活动会话。
    }
  }

  if (entries.length === 0) {
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions && typeof sessions.list === 'function') {
      try {
        const list = sessions.list()
        if (Array.isArray(list)) {
          for (const session of list) {
            const header = session && typeof session === 'object' ? session.header : null
            if (!header || typeof header !== 'object') continue
            if (header.parentSession !== sessionId) continue
            const id = typeof header.id === 'string' ? header.id : ''
            if (!id || seen.has(id)) continue
            seen.add(id)
            entries.push({
              id,
              parentId: sessionId,
              depth: Math.max(1, numberOr(header.delegationDepth, 1)),
              mode: 'unknown',
              label: '',
              hasChildren: false,
              activity: 'inactive',
              createdAt: numberOr(header.createdAt, null)
            })
          }
        }
      } catch {
        // 活动会话扫描失败时按没有子代理处理。
      }
    }
  }
  return entries
}

function sortSubagents(entries) {
  return entries.slice().sort((left, right) => numberOr(left.createdAt, 0) - numberOr(right.createdAt, 0))
}

function scanSubagentLinks(parentEvents, discovered) {
  if (!Array.isArray(parentEvents) || discovered.length === 0) return []
  const ids = new Set(discovered.map((entry) => entry.id))
  const toolsByCall = new Map()
  const links = []

  for (const raw of parentEvents) {
    if (!raw || typeof raw !== 'object') continue
    const type = typeof raw.type === 'string' ? raw.type : ''
    const data = raw.data && typeof raw.data === 'object' ? raw.data : {}
    if (type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : ''
      if (!callId) continue
      toolsByCall.set(callId, {
        callId,
        name: typeof data.name === 'string' && data.name ? data.name : '未知工具',
        turn: numberOr(data.turn, null),
        step: numberOr(data.step, null),
        arguments: typeof data.arguments === 'string' ? data.arguments : jsonPreview(data.arguments, MAX_ARGS).text,
        resultText: ''
      })
    } else if (type === 'tool/result') {
      const message = data.message && typeof data.message === 'object' ? data.message : null
      const callId =
        typeof message?.toolCallId === 'string' ? message.toolCallId : typeof data.callId === 'string' ? data.callId : ''
      const tool = callId ? toolsByCall.get(callId) : undefined
      if (tool) tool.resultText = textOf(message?.content ?? message?.text ?? data.content)
    }
  }

  for (const tool of toolsByCall.values()) {
    const haystack = `${tool.arguments}\n${tool.resultText}`
    if (!haystack) continue
    for (const id of ids) {
      if (!haystack.includes(id)) continue
      ids.delete(id)
      links.push({ childId: id, turn: tool.turn, step: tool.step, callId: tool.callId, name: tool.name })
    }
    if (ids.size === 0) break
  }
  return links
}

function summarizeMeta(sessionId, header, events) {
  const now = Date.now()
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let errors = 0
  let attempts = 0
  let firstEventTime = null
  let lastEventTime = null
  let model = null
  let contextWindow = null
  let lastTurnNumber = null
  let lastTurnOpen = false
  let lastUserText = ''
  let lastAssistantText = ''
  const usage = emptyUsage()

  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const type = typeof raw.type === 'string' ? raw.type : ''
    const data = raw.data && typeof raw.data === 'object' ? raw.data : {}
    const eventTime = typeof raw.time === 'number' && Number.isFinite(raw.time) ? raw.time : now
    if (firstEventTime === null) firstEventTime = eventTime
    lastEventTime = eventTime
    const turnNumber = numberOr(data.turn, null)

    switch (type) {
      case 'user/message': {
        lastUserText = cutText(textOf(data.content ?? data.message?.content ?? data.text), 260).text
        break
      }
      case 'turn/start': {
        turns += 1
        lastTurnNumber = turnNumber
        lastTurnOpen = true
        break
      }
      case 'turn/end': {
        if (lastTurnNumber === null || lastTurnNumber === turnNumber) lastTurnOpen = false
        break
      }
      case 'step/start': {
        steps += 1
        break
      }
      case 'request/header': {
        const callHeader = data.header && typeof data.header === 'object' ? data.header : null
        const config = callHeader && callHeader.config && typeof callHeader.config === 'object' ? callHeader.config : null
        if (config) {
          model = {
            provider: providerLabel(config.provider),
            model: typeof config.model === 'string' ? config.model : null
          }
          contextWindow = numericOrNull(config.contextWindow)
        }
        break
      }
      case 'request/context': {
        if (typeof data.model === 'string' && data.model) {
          model = { provider: providerLabel(data.provider), model: data.model }
          const window = numericOrNull(data.contextWindow)
          if (window !== null) contextWindow = window
        }
        break
      }
      case 'assistant/attempt': {
        attempts += 1
        break
      }
      case 'assistant/message': {
        if (data.usage && typeof data.usage === 'object') accumulateUsage(usage, data.usage)
        const message = data.message && typeof data.message === 'object' ? data.message : null
        const text = cutText(assistantText(message) || streamText(data.stream), 260)
        if (text.text) lastAssistantText = text.text
        break
      }
      case 'tool/call': {
        toolCalls += 1
        break
      }
      case 'tool/result': {
        const message = data.message && typeof data.message === 'object' ? data.message : null
        if (message?.isError === true || (data.error !== undefined && data.error !== null)) errors += 1
        break
      }
      default:
        break
    }
  }

  const createdAt = header && typeof header === 'object' && typeof header.createdAt === 'number' ? header.createdAt : null
  return {
    id: sessionId,
    running: lastTurnOpen,
    turns,
    steps,
    toolCalls,
    errors,
    attempts,
    model: model ? { provider: model.provider ?? null, model: model.model ?? null, contextWindow } : null,
    createdAt,
    startedAt: firstEventTime,
    lastEventTime,
    durationMs:
      firstEventTime !== null && lastEventTime !== null ? Math.max(0, lastEventTime - firstEventTime) : 0,
    usage,
    lastUserText,
    lastAssistantText,
    eventCount: Array.isArray(events) ? events.length : 0
  }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  }
}

function accumulateUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) target[key] += value
  }
}

function describeTurnReason(reason) {
  if (!reason || typeof reason !== 'object') return null
  const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
  let detail = ''
  if (kind === 'error' && reason.error && typeof reason.error === 'object') {
    detail = typeof reason.error.message === 'string' ? reason.error.message : ''
  } else if (kind === 'aborted') {
    const cancel = reason.reason
    if (cancel && typeof cancel === 'object') {
      const cancelKind = typeof cancel.kind === 'string' ? cancel.kind : ''
      detail = cancelKind === 'hook' && typeof cancel.reason === 'string' ? `hook: ${cancel.reason}` : cancelKind
    } else if (typeof cancel === 'string') {
      detail = cancel
    }
  }
  return { kind, detail: detail ? cutText(detail, MAX_DETAIL).text : '' }
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = []
    for (const item of value) {
      if (typeof item === 'string') parts.push(item)
      else if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text)
    }
    return parts.join('')
  }
  return ''
}

function reasoningOf(value) {
  if (!Array.isArray(value)) return ''
  const parts = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const type = typeof item.type === 'string' ? item.type : ''
    if (type !== 'reasoning' && type !== 'thinking' && type !== 'redacted-reasoning') continue
    const text =
      typeof item.text === 'string'
        ? item.text
        : typeof item.reasoning === 'string'
          ? item.reasoning
          : typeof item.thinking === 'string'
            ? item.thinking
            : ''
    if (text) parts.push(text)
  }
  return parts.join('')
}

function assistantText(message) {
  if (!message || typeof message !== 'object') return ''
  for (const candidate of [message.content, message.parts, message.blocks]) {
    const text = textOf(candidate)
    if (text) return text
  }
  return typeof message.text === 'string' ? message.text : ''
}

function assistantReasoning(message) {
  if (!message || typeof message !== 'object') return ''
  const parts = []
  for (const candidate of [message.content, message.parts, message.blocks]) {
    const text = reasoningOf(candidate)
    if (text) parts.push(text)
  }
  if (typeof message.reasoning === 'string') parts.push(message.reasoning)
  return parts.join('')
}

function streamText(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const record of stream) {
    if (record && typeof record === 'object' && record.type === 'text-chunks' && Array.isArray(record.texts)) {
      parts.push(record.texts.join(''))
    }
  }
  return parts.join('')
}

function streamReasoning(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const record of stream) {
    if (record && typeof record === 'object' && record.type === 'reasoning-chunks' && Array.isArray(record.texts)) {
      parts.push(record.texts.join(''))
    }
  }
  return parts.join('')
}

function summarizeStream(stream) {
  if (!Array.isArray(stream) || stream.length === 0) return null
  let first = null
  let last = null
  let chunks = 0
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue
    if (typeof record.time0 === 'number' && Number.isFinite(record.time0)) {
      let localLast = record.time0
      const deltas = Array.isArray(record.dt) ? record.dt : []
      for (const delta of deltas) {
        if (typeof delta === 'number' && Number.isFinite(delta)) localLast = Math.max(localLast, record.time0 + delta)
      }
      const size = Array.isArray(record.texts) ? record.texts.length : Array.isArray(record.args) ? record.args.length : deltas.length
      chunks += size
      first = first === null ? record.time0 : Math.min(first, record.time0)
      last = last === null ? localLast : Math.max(last, localLast)
    } else if (typeof record.time === 'number' && Number.isFinite(record.time)) {
      chunks += 1
      first = first === null ? record.time : Math.min(first, record.time)
      last = last === null ? record.time : Math.max(last, record.time)
    }
  }
  if (first === null) return null
  return { firstAt: first, lastAt: last === null ? first : last, chunkCount: chunks, epoch: first > 1e12 }
}

function cutText(value, limit) {
  if (typeof value !== 'string') return { text: '', truncated: false }
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, limit), truncated: true }
}

function fullTextOf(text) {
  return typeof text === 'string' ? cutText(text, MAX_FULL).text : ''
}

function fullJsonOf(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return cutText(value, MAX_FULL).text
  try {
    return cutText(JSON.stringify(value, null, 2), MAX_FULL).text
  } catch {
    return cutText(String(value), MAX_FULL).text
  }
}

function jsonPreview(value, limit) {
  if (value === undefined || value === null) return { text: '', truncated: false }
  if (typeof value === 'string') return cutText(value, limit)
  try {
    return cutText(JSON.stringify(value, null, 2), limit)
  } catch {
    return cutText(String(value), limit)
  }
}

function providerLabel(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    if (typeof value.id === 'string') return value.id
    if (typeof value.name === 'string') return value.name
    if (typeof value.provider === 'string') return value.provider
  }
  return null
}

function numericOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberOr(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

function textOrNull(value) {
  return typeof value === 'string' && value ? value : null
}
