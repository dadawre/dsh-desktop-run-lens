/**
 * 运行透视（Run Lens）— DSH Desktop 工作台客户端面板。
 *
 * 读取服务端快照（紧凑摘要），按「回合 → 步骤 → 模型调用 / 工具调用」展示运行过程。
 * 长文本、完整参数与返回通过 detail 接口按需加载，避免轮询时传输大体积内容。
 *
 * 这个文件是构建好的单文件客户端入口：Desktop 不会替插件构建，直接由模块加载器执行。
 * 因此这里只用 React.createElement（不引入 JSX / 构建步骤），并通过 window.__ModuleLoader__ 注册。
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-run-lens',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const SNAPSHOT_PATH = '/api/dsh-desktop-run-lens/snapshot'
    const DETAIL_PATH = '/api/dsh-desktop-run-lens/detail'
    const SUBAGENTS_PATH = '/api/dsh-desktop-run-lens/subagents'
    const STYLE_ID = 'dsh-desktop-run-lens-style'
    const PRESET_KEY = 'dsh-desktop-run-lens.view-presets.v1'
    const SESSION_POLL_MS = 900
    const RUNNING_POLL_MS = 1200
    const IDLE_POLL_MS = 3500
    const SUBAGENT_POLL_MS = 5000
    const FOLLOW_BOTTOM_PX = 32
    const FOLLOW_AWAY_PX = 220

    const FILTERS = [
      { id: 'all', label: '全部' },
      { id: 'model', label: '模型' },
      { id: 'tool', label: '工具' },
      { id: 'error', label: '错误' }
    ]

    const VIEWS = [
      { id: 'chat', label: '会话' },
      { id: 'timeline', label: '时间线' },
      { id: 'unified', label: '全景图' }
    ]

    function viewLabel(id) {
      const found = VIEWS.find((item) => item.id === id)
      return found ? found.label : id
    }

    function filterLabel(id) {
      const found = FILTERS.find((item) => item.id === id)
      return found ? found.label : id
    }

    function readViewPresets() {
      try {
        const raw = window.localStorage.getItem(PRESET_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        if (!Array.isArray(parsed)) return []
        return parsed.filter(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            VIEWS.some((view) => view.id === item.view)
        )
      } catch {
        return []
      }
    }

    function writeViewPresets(presets) {
      try {
        window.localStorage.setItem(PRESET_KEY, JSON.stringify(presets))
      } catch {
        // 本地存储不可用时预设只在本次会话内生效。
      }
    }

    const inject = ['desktopWorkbenches']

    /* ------------------------------------------------------------------ */
    /* 面板                                                                */
    /* ------------------------------------------------------------------ */

    function BusinessPanel({ service }) {
      const [sessionId, setSessionId] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [reloadKey, setReloadKey] = React.useState(0)
      const [turnOpen, setTurnOpen] = React.useState({})
      const [toolOpen, setToolOpen] = React.useState({})
      const [reasonOpen, setReasonOpen] = React.useState({})
      const [textOpen, setTextOpen] = React.useState({})
      const [userOpen, setUserOpen] = React.useState({})
      const [details, setDetails] = React.useState({})
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [follow, setFollow] = React.useState(true)
      const [showJump, setShowJump] = React.useState(false)
      const [clock, setClock] = React.useState(() => Date.now())
      const [copied, setCopied] = React.useState(null)
      const [view, setView] = React.useState('unified')
      const [presets, setPresets] = React.useState(() => readViewPresets())
      const [presetId, setPresetId] = React.useState('')
      const [presetEditing, setPresetEditing] = React.useState(false)
      const [presetName, setPresetName] = React.useState('')
      const [subagentTrail, setSubagentTrail] = React.useState([])
      const [subagents, setSubagents] = React.useState(null)
      const [subagentError, setSubagentError] = React.useState(null)
      const [childSnapshot, setChildSnapshot] = React.useState(null)
      const [childError, setChildError] = React.useState(null)
      const [childLoading, setChildLoading] = React.useState(false)
      const [expandedAgents, setExpandedAgents] = React.useState({})
      const [agentSnapshots, setAgentSnapshots] = React.useState({})
      const [agentErrors, setAgentErrors] = React.useState({})
      const [agentLinks, setAgentLinks] = React.useState({})
      const [nestedMeta, setNestedMeta] = React.useState({})
      const [focusTurnNo, setFocusTurnNo] = React.useState(null)
      const [selectedNode, setSelectedNode] = React.useState(null)
      const scrollRef = React.useRef(null)
      const followRef = React.useRef(true)
      const sessionRef = React.useRef(null)
      const snapshotRef = React.useRef(null)
      const displaySessionRef = React.useRef(null)
      const childSnapshotRef = React.useRef(null)
      const copyTimerRef = React.useRef(null)

      followRef.current = follow
      sessionRef.current = sessionId
      snapshotRef.current = snapshot
      childSnapshotRef.current = childSnapshot

      const trailEntry = subagentTrail.length ? subagentTrail[subagentTrail.length - 1] : null
      const displaySessionId = trailEntry ? trailEntry.id : sessionId
      const activeSnapshot = trailEntry ? childSnapshot : snapshot
      const activeError = trailEntry ? childError : error
      const activeLoading = trailEntry ? childLoading : loading
      const activeRunning = Boolean(activeSnapshot && activeSnapshot.session && activeSnapshot.session.running)
      displaySessionRef.current = displaySessionId

      React.useEffect(() => {
        return () => {
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        }
      }, [])

      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        if (document.getElementById(STYLE_ID)) return undefined
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLES
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, [])

      React.useEffect(() => {
        let disposed = false
        let timer = null
        const tick = () => {
          if (disposed) return
          let next = null
          try {
            next = typeof service.currentSession === 'function' ? service.currentSession() : null
          } catch {
            next = null
          }
          setSessionId((previous) => (previous === next ? previous : next || null))
          timer = setTimeout(tick, SESSION_POLL_MS)
        }
        tick()
        return () => {
          disposed = true
          if (timer) clearTimeout(timer)
        }
      }, [service])

      React.useEffect(() => {
        setSnapshot(null)
        setError(null)
        setLoading(false)
        setDetails({})
        setTurnOpen({})
        setToolOpen({})
        setReasonOpen({})
        setTextOpen({})
        setUserOpen({})
        setQuery('')
        setFilter('all')
        setFollow(true)
        setShowJump(false)
        setFocusTurnNo(null)
        setSelectedNode(null)
        setSubagentTrail([])
        setSubagents(null)
        setSubagentError(null)
        setChildSnapshot(null)
        setChildError(null)
        setChildLoading(false)
        setExpandedAgents({})
        setAgentSnapshots({})
        setAgentErrors({})
        setAgentLinks({})
        setNestedMeta({})
      }, [sessionId])

      React.useEffect(() => {
        if (!sessionId) {
          setSnapshot(null)
          setLoading(false)
          return undefined
        }
        let active = true
        let timer = null
        let controller = null

        const load = async () => {
          if (!active) return
          if (controller) controller.abort()
          controller = new AbortController()
          if (!snapshotRef.current) setLoading(true)
          try {
            const response = await fetch(`${SNAPSHOT_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
              cache: 'no-store',
              signal: controller.signal,
              headers: { accept: 'application/json' }
            })
            const payload = await response.json().catch(() => null)
            if (!active) return
            if (!response.ok || !payload || payload.ok !== true) {
              const message = payload && payload.error ? payload.error : `读取运行记录失败（HTTP ${response.status}）`
              throw new Error(message)
            }
            setSnapshot(payload)
            setError(null)
            setLoading(false)
            const running = Boolean(payload.session && payload.session.running)
            timer = setTimeout(load, running ? RUNNING_POLL_MS : IDLE_POLL_MS)
          } catch (readError) {
            if (!active) return
            if (readError && readError.name === 'AbortError') return
            setError(readError && readError.message ? readError.message : String(readError))
            setLoading(false)
            timer = setTimeout(load, IDLE_POLL_MS)
          }
        }

        load()
        return () => {
          active = false
          if (timer) clearTimeout(timer)
          if (controller) controller.abort()
        }
      }, [sessionId, reloadKey])

      // 切换主会话 / 子代理时清空只属于上一个会话的展开与详情状态。
      React.useEffect(() => {
        setDetails({})
        setSelectedNode(null)
        setFocusTurnNo(null)
        setToolOpen({})
        setReasonOpen({})
        setTextOpen({})
        setUserOpen({})
        setTurnOpen({})
        setExpandedAgents({})
        setAgentSnapshots({})
        setAgentErrors({})
        setAgentLinks({})
        setNestedMeta({})
      }, [displaySessionId])

      // 进入子代理时单独拉取它的快照（子代理本身也是一张运行图）。
      React.useEffect(() => {
        if (!trailEntry) {
          setChildSnapshot(null)
          setChildError(null)
          setChildLoading(false)
          return undefined
        }
        let active = true
        let timer = null
        let controller = null
        const load = async () => {
          if (!active) return
          if (controller) controller.abort()
          controller = new AbortController()
          if (!childSnapshotRef.current) setChildLoading(true)
          try {
            const response = await fetch(`${SNAPSHOT_PATH}?sessionId=${encodeURIComponent(trailEntry.id)}`, {
              cache: 'no-store',
              signal: controller.signal,
              headers: { accept: 'application/json' }
            })
            const payload = await response.json().catch(() => null)
            if (!active) return
            if (!response.ok || !payload || payload.ok !== true) {
              const message = payload && payload.error ? payload.error : `读取子代理运行记录失败（HTTP ${response.status}）`
              throw new Error(message)
            }
            setChildSnapshot(payload)
            setChildError(null)
            setChildLoading(false)
            const childRunning = Boolean(payload.session && payload.session.running)
            timer = setTimeout(load, childRunning ? RUNNING_POLL_MS : IDLE_POLL_MS)
          } catch (readError) {
            if (!active) return
            if (readError && readError.name === 'AbortError') return
            setChildError(readError && readError.message ? readError.message : String(readError))
            setChildLoading(false)
            timer = setTimeout(load, IDLE_POLL_MS)
          }
        }
        load()
        return () => {
          active = false
          if (timer) clearTimeout(timer)
          if (controller) controller.abort()
        }
      }, [trailEntry ? trailEntry.id : null, reloadKey])

      // 子代理目录：当前展示的会话由哪些子代理组成、以及父会话里对应的工具调用。
      React.useEffect(() => {
        if (!displaySessionId) {
          setSubagents(null)
          return undefined
        }
        let active = true
        let timer = null
        const load = async () => {
          if (!active) return
          try {
            const response = await fetch(`${SUBAGENTS_PATH}?sessionId=${encodeURIComponent(displaySessionId)}`, {
              cache: 'no-store',
              headers: { accept: 'application/json' }
            })
            const payload = await response.json().catch(() => null)
            if (!active) return
            if (!response.ok || !payload || payload.ok !== true) {
              const message = payload && payload.error ? payload.error : `读取子代理失败（HTTP ${response.status}）`
              throw new Error(message)
            }
            setSubagents(payload)
            setSubagentError(null)
          } catch (readError) {
            if (!active) return
            setSubagentError(readError && readError.message ? readError.message : String(readError))
          }
          timer = setTimeout(load, SUBAGENT_POLL_MS)
        }
        load()
        return () => {
          active = false
          if (timer) clearTimeout(timer)
        }
      }, [displaySessionId, reloadKey])

      // 全景图需要画每个子代理自己的运行图：进入某个会话后按链接按需拉取子代理快照。
      const linkedChildIds = React.useMemo(() => {
        const ids = []
        const seen = new Set()
        const links = subagents && Array.isArray(subagents.links) ? subagents.links : []
        for (const link of links) {
          if (!link || typeof link.childId !== 'string' || !link.childId) continue
          if (seen.has(link.childId)) continue
          seen.add(link.childId)
          ids.push(link.childId)
        }
        return ids
      }, [subagents])

      React.useEffect(() => {
        if (!displaySessionId) return undefined
        let active = true
        const expandedTargets = Object.keys(expandedAgents).filter((id) => expandedAgents[id])
        const targets = Array.from(new Set(linkedChildIds.concat(expandedTargets))).filter(
          (id) => !agentSnapshots[id] && !agentErrors[id]
        )
        if (targets.length === 0) return undefined
        const loadOne = async (childId) => {
          try {
            const response = await fetch(`${SNAPSHOT_PATH}?sessionId=${encodeURIComponent(childId)}`, {
              cache: 'no-store',
              headers: { accept: 'application/json' }
            })
            const payload = await response.json().catch(() => null)
            if (!active) return
            if (!response.ok || !payload || payload.ok !== true) {
              const message = payload && payload.error ? payload.error : `读取子代理快照失败（HTTP ${response.status}）`
              setAgentErrors((previous) => ({ ...previous, [childId]: message }))
              return
            }
            setAgentSnapshots((previous) => ({ ...previous, [childId]: payload }))
          } catch (readError) {
            if (!active) return
            setAgentErrors((previous) => ({
              ...previous,
              [childId]: readError && readError.message ? readError.message : String(readError)
            }))
          }
        }
        const run = async () => {
          for (const childId of targets) {
            if (!active) return
            await loadOne(childId)
          }
        }
        run()
        return () => {
          active = false
        }
      }, [displaySessionId, linkedChildIds, expandedAgents, agentSnapshots, agentErrors])

      // 子代理里的工具如果再调用子代理（嵌套），进入展开后按需拉取它自己的 links 与子代理目录。
      React.useEffect(() => {
        if (!displaySessionId) return undefined
        const wanted = Object.keys(expandedAgents).filter(
          (id) => expandedAgents[id] && agentSnapshots[id] && agentLinks[id] === undefined
        )
        if (wanted.length === 0) return undefined
        let active = true
        setAgentLinks((previous) => {
          const next = { ...previous }
          for (const id of wanted) if (next[id] === undefined) next[id] = null
          return next
        })
        const loadOne = async (childId) => {
          try {
            const response = await fetch(`${SUBAGENTS_PATH}?sessionId=${encodeURIComponent(childId)}`, {
              cache: 'no-store',
              headers: { accept: 'application/json' }
            })
            const payload = await response.json().catch(() => null)
            if (!active) return
            const ok = response.ok && payload && payload.ok === true
            const links = ok && Array.isArray(payload.links) ? payload.links : []
            const entries = ok && Array.isArray(payload.subagents) ? payload.subagents : []
            setAgentLinks((previous) => ({ ...previous, [childId]: links }))
            if (entries.length) {
              setNestedMeta((previous) => {
                const next = { ...previous }
                for (const entry of entries) {
                  if (entry && typeof entry.id === 'string') next[entry.id] = entry
                }
                return next
              })
            }
          } catch {
            if (active) setAgentLinks((previous) => ({ ...previous, [childId]: [] }))
          }
        }
        const run = async () => {
          for (const childId of wanted) {
            if (!active) return
            await loadOne(childId)
          }
        }
        run()
        return () => {
          active = false
        }
      }, [displaySessionId, expandedAgents, agentSnapshots, agentLinks])

      // 子代理不带折叠交互：所有已发现的子代理（含嵌套）始终并入全景图。
      React.useEffect(() => {
        const wanted = new Set(linkedChildIds)
        for (const entries of Object.values(agentLinks)) {
          if (!Array.isArray(entries)) continue
          for (const entry of entries) {
            if (entry && typeof entry.childId === 'string') wanted.add(entry.childId)
          }
        }
        for (const nestedId of Object.keys(nestedMeta)) wanted.add(nestedId)
        setExpandedAgents((previous) => {
          let changed = false
          const next = { ...previous }
          for (const childId of wanted) {
            if (next[childId] !== true) {
              next[childId] = true
              changed = true
            }
          }
          return changed ? next : previous
        })
      }, [linkedChildIds, agentLinks, nestedMeta])

      // 已展开的子代理可能仍在运行：定时刷新其快照，让图里的步骤与状态保持最新。
      React.useEffect(() => {
        if (!displaySessionId) return undefined
        const ids = Object.keys(expandedAgents).filter((childId) => expandedAgents[childId])
        if (ids.length === 0) return undefined
        let active = true
        const refreshOne = async (childId) => {
          try {
            const response = await fetch(`${SNAPSHOT_PATH}?sessionId=${encodeURIComponent(childId)}`, {
              cache: 'no-store',
              headers: { accept: 'application/json' }
            })
            const payload = await response.json().catch(() => null)
            if (!active || !response.ok || !payload || payload.ok !== true) return
            setAgentSnapshots((previous) => ({ ...previous, [childId]: payload }))
          } catch {
            // 单次刷新失败不打断轮询；下一轮或手动重试会恢复。
          }
        }
        const timer = setInterval(() => {
          for (const childId of ids) {
            if (!active) return
            refreshOne(childId)
          }
        }, 8000)
        return () => {
          active = false
          clearInterval(timer)
        }
      }, [displaySessionId, expandedAgents])

      const running = activeRunning

      React.useEffect(() => {
        if (!running) return undefined
        const id = setInterval(() => setClock(Date.now()), 1000)
        return () => clearInterval(id)
      }, [running])

      const generatedAt = activeSnapshot ? activeSnapshot.generatedAt : null

      React.useEffect(() => {
        if (!follow) return undefined
        if (view !== 'timeline') return undefined
        if (query.trim() || filter !== 'all') return undefined
        const element = scrollRef.current
        if (!element) return undefined
        const raf = requestAnimationFrame(() => {
          element.scrollTop = element.scrollHeight
          setShowJump(false)
        })
        return () => cancelAnimationFrame(raf)
      }, [follow, generatedAt, query, filter])

      const listView = React.useMemo(() => filterTurns(activeSnapshot, query, filter), [activeSnapshot, query, filter])

      const handleScroll = () => {
        const element = scrollRef.current
        if (!element) return
        const remaining = element.scrollHeight - element.clientHeight - element.scrollTop
        if (remaining < FOLLOW_BOTTOM_PX) {
          if (!followRef.current) setFollow(true)
          if (showJump) setShowJump(false)
        } else if (remaining > FOLLOW_AWAY_PX) {
          if (followRef.current) setFollow(false)
          if (!showJump) setShowJump(true)
        }
      }

      const scrollToBottom = () => {
        const element = scrollRef.current
        if (!element) return
        element.scrollTop = element.scrollHeight
        setFollow(true)
        setShowJump(false)
      }

      const jumpToTurn = (turnNumber) => {
        const container = scrollRef.current
        if (!container) return
        const target = container.querySelector(`[data-turn="${turnNumber}"]`)
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'start' })
          setFollow(false)
          setShowJump(true)
        }
      }

      const copyText = async (text, key) => {
        if (!text) return
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text)
          } else {
            // 旧版 WebView 没有异步剪贴板 API 时退回 execCommand。
            const area = document.createElement('textarea')
            area.value = text
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            area.remove()
          }
          setCopied(key)
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => setCopied(null), 1500)
        } catch {
          // 剪贴板不可用（权限/安全上下文）时静默失败，不打断查看。
        }
      }

      const loadDetail = async (turnNumber, stepNumber) => {
        const currentSession = displaySessionRef.current
        if (!currentSession) return
        const key = `${turnNumber}:${stepNumber}`
        setDetails((previous) => ({ ...previous, [key]: { loading: true } }))
        try {
          const response = await fetch(
            `${DETAIL_PATH}?sessionId=${encodeURIComponent(currentSession)}&turn=${turnNumber}&step=${stepNumber}`,
            { cache: 'no-store', headers: { accept: 'application/json' } }
          )
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true) {
            const message = payload && payload.error ? payload.error : `读取详情失败（HTTP ${response.status}）`
            throw new Error(message)
          }
          if (displaySessionRef.current !== currentSession) return
          setDetails((previous) => ({ ...previous, [key]: { data: payload.detail } }))
        } catch (readError) {
          if (displaySessionRef.current !== currentSession) return
          setDetails((previous) => ({
            ...previous,
            [key]: { error: readError && readError.message ? readError.message : String(readError) }
          }))
        }
      }

      const toggleTurn = (turnNumber, expanded) => {
        setTurnOpen((previous) => ({ ...previous, [turnNumber]: !expanded }))
      }

      const toggleTool = (turnNumber, stepNumber, callId, needsDetail) => {
        const key = `${turnNumber}:${stepNumber}:${callId}`
        setToolOpen((previous) => ({ ...previous, [key]: !previous[key] }))
        if (needsDetail) {
          const detailKey = `${turnNumber}:${stepNumber}`
          const existing = details[detailKey]
          if (!existing || (!existing.data && !existing.loading && !existing.error)) loadDetail(turnNumber, stepNumber)
        }
      }

      const toggleReason = (turnNumber, stepNumber) => {
        const key = `${turnNumber}:${stepNumber}`
        setReasonOpen((previous) => ({ ...previous, [key]: !previous[key] }))
      }

      const toggleText = (turnNumber, stepNumber) => {
        const key = `${turnNumber}:${stepNumber}`
        setTextOpen((previous) => ({ ...previous, [key]: !previous[key] }))
      }

      const toggleUser = (turnNumber) => {
        setUserOpen((previous) => ({ ...previous, [turnNumber]: !previous[turnNumber] }))
      }

      const expandAll = () => {
        const next = {}
        for (const turn of (activeSnapshot && activeSnapshot.turns) || []) next[turn.turn] = true
        setTurnOpen(next)
      }

      const collapseAll = () => {
        const next = {}
        for (const turn of (activeSnapshot && activeSnapshot.turns) || []) next[turn.turn] = false
        setTurnOpen(next)
      }

      // 从会话/时间线跳到全景图里的同一步，视为“查看详情”的快捷入口。
      const jumpToStep = (turnNumber, stepNumber, callId) => {
        setView('unified')
        setSelectedNode(
          callId ? `${turnNumber}:tool:${stepNumber}:${callId}` : `${turnNumber}:model:${stepNumber}`
        )
      }

      // 子代理节点只用于查看详情，不提供展开/收起；所有子代理始终显示在图中。

      const actions = {
        toggleTurn,
        toggleTool,
        toggleReason,
        toggleText,
        toggleUser,
        jumpToStep,
        loadDetail,
        copy: copyText
      }

      const openSubagent = (entry) => {
        if (!entry || typeof entry.id !== 'string' || !entry.id) return
        setSubagentTrail((previous) =>
          previous.concat([
            {
              id: entry.id,
              label: entry.label || shortId(entry.id),
              mode: entry.mode || 'unknown'
            }
          ])
        )
      }

      const popSubagent = (level) => {
        setSubagentTrail((previous) => {
          if (!Number.isInteger(level) || level < 0) return previous.slice(0, previous.length - 1)
          return previous.slice(0, level)
        })
      }

      const applyPreset = (id) => {
        const preset = presets.find((item) => item.id === id)
        if (!preset) return
        setPresetId(id)
        setView(preset.view)
        setFilter(preset.filter || 'all')
        setFollow(preset.follow !== false)
      }

      const savePreset = () => {
        const name = (presetName || '').trim() || `${viewLabel(view)} · ${filterLabel(filter)}`
        const entry = { id: `preset-${Date.now()}`, name: name.slice(0, 40), view, filter, follow }
        const next = presets.concat([entry]).slice(-12)
        setPresets(next)
        writeViewPresets(next)
        setPresetName('')
        setPresetEditing(false)
        setPresetId(entry.id)
      }

      const deletePreset = () => {
        if (!presetId) return
        const next = presets.filter((item) => item.id !== presetId)
        setPresets(next)
        writeViewPresets(next)
        setPresetId('')
      }

      const activeTurns = activeSnapshot && Array.isArray(activeSnapshot.turns) ? activeSnapshot.turns : []
      const turnNumbers = activeTurns.map((turn) => turn.turn)
      const lastTurn = turnNumbers.length ? turnNumbers[turnNumbers.length - 1] : null
      const forceOpen = listView.matched
      const focusTurn = activeTurns.length
        ? activeTurns.find((turn) => turn.turn === focusTurnNo) || activeTurns[activeTurns.length - 1]
        : null
      const activeLinks = subagents && Array.isArray(subagents.links) ? subagents.links : []
      const childList = subagents && Array.isArray(subagents.subagents) ? subagents.subagents : []
      const showSubagentBar = subagentTrail.length > 0 || childList.length > 0 || Boolean(subagentError)
      const agentMeta = React.useMemo(() => {
        const meta = {}
        for (const entry of childList) {
          if (entry && typeof entry.id === 'string') meta[entry.id] = entry
        }
        for (const entry of Object.values(nestedMeta)) {
          if (entry && typeof entry.id === 'string' && !meta[entry.id]) meta[entry.id] = entry
        }
        return meta
      }, [childList, nestedMeta])

      // 所有可展开的子代理（含通过嵌套发现的孙代理），用于“展开 / 收起全部”按钮。
      const expandableAgentIds = React.useMemo(() => {
        const ids = new Set(linkedChildIds)
        for (const entries of Object.values(agentLinks)) {
          if (!Array.isArray(entries)) continue
          for (const entry of entries) {
            if (entry && typeof entry.childId === 'string' && entry.childId) ids.add(entry.childId)
          }
        }
        for (const childId of Object.keys(nestedMeta)) ids.add(childId)
        return Array.from(ids)
      }, [linkedChildIds, agentLinks, nestedMeta])

      React.useEffect(() => {
        setSelectedNode(null)
      }, [focusTurn ? focusTurn.turn : null])

      // 只在面板内按键生效（root 是 tabIndex=0 的容器），避免抢主对话的键盘输入。
      const handlePanelKeyDown = (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        const target = event.target
        const tag = target && target.tagName ? target.tagName : ''
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return
        const key = event.key
        if (key === 'Escape') {
          setSelectedNode(null)
          return
        }
        const viewIndex = Number(key)
        if (Number.isInteger(viewIndex) && viewIndex >= 1 && viewIndex <= VIEWS.length) {
          setView(VIEWS[viewIndex - 1].id)
          event.preventDefault()
          return
        }
        if (key === 'e' || key === 'E') {
          if (view === 'timeline') {
            const allOpen = listView.turns.every((entry) => turnOpen[entry.turn.turn] !== false)
            if (allOpen) collapseAll()
            else expandAll()
          }
          event.preventDefault()
          return
        }
        if (key === 'f' || key === 'F') {
          setFollow((value) => !value)
          event.preventDefault()
          return
        }
      }

      return h(
        'div',
        {
          className: 'rl-root rl-view-' + view + (view !== 'timeline' ? ' rl-mode-flow' : ''),
          tabIndex: 0,
          onKeyDown: handlePanelKeyDown,
          title: '快捷键：1-3 切视图 · f 跟随 · e 展开/收起（时间线）'
        },        h(Header, {
          snapshot: activeSnapshot,
          loading: activeLoading,
          error: activeError,
          onRefresh: () => setReloadKey((value) => value + 1)
        }),
        h(Metrics, { snapshot: activeSnapshot }),
        showSubagentBar
          ? h(SubagentBar, {
              trail: subagentTrail,
              subagents: childList,
              error: subagentError,
              onOpen: openSubagent,
              onExit: popSubagent
            })
          : null,
        h(
          'div',
          { className: 'rl-toolbar' },
          h(
            'div',
            { className: 'rl-chips rl-mode-row' },
            VIEWS.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  className: 'rl-chip' + (view === item.id ? ' rl-chip-active' : ''),
                  onClick: () => setView(item.id)
                },
                item.label
              )
            ),
            h('span', { className: 'rl-spacer' }),
            view === 'unified' && activeSnapshot
              ? h(
                  'span',
                  { className: 'rl-count' },
                  `${activeTurns.length} 回合 · ${activeSnapshot.totals.steps} 步 · ${activeSnapshot.totals.toolCalls} 工具`
                )
              : null,
            view === 'unified' && expandableAgentIds.length > 0
              ? h(
                  'span',
                  { className: 'rl-count', title: '所有子代理（含嵌套）已并入全景图，无需展开' },
                  `已并入 ${expandableAgentIds.length} 个子代理`
                )
              : null
          ),
          h(
            'div',
            { className: 'rl-chips rl-preset-row' },
            h('span', { className: 'rl-toolbar-label' }, '预设'),
            h(
              'select',
              {
                className: 'rl-preset-select',
                value: presetId,
                title: '应用已保存的视图预设',
                onChange: (event) => applyPreset(event.target.value)
              },
              h('option', { value: '' }, presets.length ? '选择预设…' : '暂无预设'),
              presets.map((preset) => h('option', { key: preset.id, value: preset.id }, preset.name))
            ),
            presetEditing
              ? h('input', {
                  className: 'rl-preset-input',
                  value: presetName,
                  placeholder: '预设名称（可留空）',
                  onChange: (event) => setPresetName(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') savePreset()
                    if (event.key === 'Escape') setPresetEditing(false)
                  }
                })
              : null,
            h(
              'button',
              { className: 'rl-mini', onClick: () => (presetEditing ? savePreset() : setPresetEditing(true)) },
              presetEditing ? '保存' : '存为预设'
            ),
            presetEditing ? h('button', { className: 'rl-mini', onClick: () => setPresetEditing(false) }, '取消') : null,
            presetId ? h('button', { className: 'rl-mini', onClick: deletePreset }, '删除预设') : null
          ),
          h(
            'div',
            { className: 'rl-search-row rl-list-only' },
            h('input', {
              className: 'rl-search',
              value: query,
              placeholder: '搜索步骤、工具、参数或输出…',
              onChange: (event) => setQuery(event.target.value)
            }),
            query
              ? h('button', { className: 'rl-clear', onClick: () => setQuery(''), title: '清空搜索' }, '×')
              : null
          ),
          h(
            'div',
            { className: 'rl-chips rl-list-only' },
            FILTERS.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  className: 'rl-chip' + (filter === item.id ? ' rl-chip-active' : ''),
                  onClick: () => setFilter(item.id)
                },
                item.label
              )
            ),
            h('span', { className: 'rl-spacer' }),
            listView.matched
              ? h('span', { className: 'rl-count' }, `${listView.total} 步匹配`)
              : h('span', { className: 'rl-count' }, `${activeSnapshot ? activeSnapshot.totals.steps : 0} 步`),
            turnNumbers.length > 1
              ? h(
                  'select',
                  {
                    className: 'rl-jump-select',
                    value: '',
                    title: '跳到某个回合',
                    onChange: (event) => {
                      const turnNumber = Number(event.target.value)
                      if (Number.isFinite(turnNumber)) jumpToTurn(turnNumber)
                    }
                  },
                  h('option', { value: '' }, '跳到回合…'),
                  turnNumbers.map((turnNumber) => h('option', { key: turnNumber, value: turnNumber }, `回合 ${turnNumber}`))
                )
              : null,
            h('button', { className: 'rl-mini', onClick: expandAll, title: '展开全部回合' }, '展开'),
            h('button', { className: 'rl-mini', onClick: collapseAll, title: '收起全部回合' }, '收起'),
            h(
              'button',
              {
                className: 'rl-mini' + (follow ? ' rl-mini-on' : ''),
                onClick: () => {
                  if (follow) {
                    setFollow(false)
                    setShowJump(true)
                  } else {
                    scrollToBottom()
                  }
                },
                title: '自动跟随最新步骤'
              },
              follow ? '跟随中' : '跟随最新'
            )
          )
        ),
        view === 'unified'
          ? h(UnifiedView, {
              snapshot: activeSnapshot,
              loading: activeLoading,
              error: activeError,
              running: activeRunning,
              clock,
              details,
              actions,
              selectedNode,
              onSelect: setSelectedNode,
              onRetry: () => setReloadKey((value) => value + 1),
              links: activeLinks,
              agentMeta,
              agentLinks,
              expandedAgents,
              agentSnapshots,
              agentErrors,
              onOpenChild: openSubagent
            })
          : view === 'flow'
          ? h(FlowView, {
              turn: focusTurn,
              loading: activeLoading,
              error: activeError,
              running: activeRunning,
              clock,
              details,
              actions,
              selectedNode,
              onSelect: setSelectedNode,
              onRetry: () => setReloadKey((value) => value + 1),
              links: activeLinks,
              onOpenChild: openSubagent
            })
          : view === 'swimlane'
            ? h(SwimlaneView, {
                turn: focusTurn,
                loading: activeLoading,
                error: activeError,
                running: activeRunning,
                clock,
                details,
                actions,
                selectedNode,
                onSelect: setSelectedNode,
                onRetry: () => setReloadKey((value) => value + 1),
                links: activeLinks,
                onOpenChild: openSubagent
              })
            : view === 'bizflow'
              ? h(BizFlowView, {
                  snapshot: activeSnapshot,
                  loading: activeLoading,
                  error: activeError,
                  running: activeRunning,
                  clock,
                  onJumpStep: jumpToStep,
                  onRetry: () => setReloadKey((value) => value + 1),
                  query,
                  filter,
                  links: activeLinks,
                  onOpenChild: openSubagent
                })
              : view === 'chat'
              ? h(ChatView, {
                  snapshot: activeSnapshot,
                  loading: activeLoading,
                  error: activeError,
                  running: activeRunning,
                  clock,
                  details,
                  actions,
                  onJumpStep: jumpToStep,
                  onRetry: () => setReloadKey((value) => value + 1)
                })
              : h(
                  'div',
                  { className: 'rl-scroll', ref: scrollRef, onScroll: handleScroll },
                  !displaySessionId
                    ? h(IdleState, null)
                    : activeError
                      ? h(ErrorState, { error: activeError, onRetry: () => setReloadKey((value) => value + 1) })
                      : !activeSnapshot
                        ? h(Skeleton, null)
                        : listView.turns.length === 0
                          ? h(EmptyState, { query, filter })
                          : listView.turns.map((entry) =>
                              h(TurnSection, {
                                key: entry.turn.turn,
                                turn: entry.turn,
                                steps: entry.steps,
                                expanded:
                                  forceOpen ||
                                  (turnOpen[entry.turn.turn] === undefined
                                    ? entry.turn.turn === lastTurn
                                    : turnOpen[entry.turn.turn] !== false),
                                userExpanded: Boolean(userOpen[entry.turn.turn]),
                                running: activeRunning,
                                clock,
                                details,
                                toolOpen,
                                reasonOpen,
                                textOpen,
                                copied,
                                actions,
                                links: activeLinks,
                                onOpenChild: openSubagent
                              })
                            ),
                  showJump ? h('button', { className: 'rl-jump', onClick: scrollToBottom }, '↓ 跳到最新') : null
                )
      )
    }

    /* ------------------------------------------------------------------ */
    /* 流程图                                                              */
    /* ------------------------------------------------------------------ */

    const FLOW = {
      pad: 18,
      mainW: 300,
      userH: 70,
      modelH: 92,
      endH: 50,
      gapY: 24,
      toolW: 176,
      toolH: 52,
      toolGapY: 8,
      branchX: 26
    }

    function clampNumber(value, min, max) {
      if (!Number.isFinite(value)) return min
      return Math.min(max, Math.max(min, value))
    }

    function countStepTools(steps) {
      let total = 0
      for (const step of steps || []) total += Array.isArray(step.toolCalls) ? step.toolCalls.length : 0
      return total
    }

    function edgePath(x1, y1, x2, y2) {
      if (Math.abs(x1 - x2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`
      return `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
    }

    function branchEdgePath(x1, y1, x2, y2) {
      const mid = (x1 + x2) / 2
      return `M ${x1} ${y1} C ${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`
    }

    /**
     * 把一个回合排成「主链 + 工具分支」的两列流程图：
     * 左列是 用户提问 → 步骤 1 模型调用 → 步骤 2 模型调用 → … → 回合结束；
     * 右列是每一步展开的工具调用，用曲线从模型节点连过去。
     */
    function layoutFlow(turn) {
      const steps = turn && Array.isArray(turn.steps) ? turn.steps : []
      const hasTools = countStepTools(steps) > 0
      const width = FLOW.pad * 2 + FLOW.mainW + (hasTools ? FLOW.branchX + FLOW.toolW : 0)
      const mainX = FLOW.pad
      const mainCx = mainX + FLOW.mainW / 2
      const toolX = mainX + FLOW.mainW + FLOW.branchX
      const nodes = []
      const edges = []
      let y = FLOW.pad

      const user = { id: 'user', kind: 'user', x: mainX, y, w: FLOW.mainW, h: FLOW.userH, turn }
      nodes.push(user)
      let spineX = mainCx
      let spineY = user.y + user.h
      y = spineY + FLOW.gapY

      for (const step of steps) {
        const model = { id: `model:${step.step}`, kind: 'model', x: mainX, y, w: FLOW.mainW, h: FLOW.modelH, step }
        nodes.push(model)
        edges.push({ id: `edge-model-${step.step}`, kind: 'main', d: edgePath(spineX, spineY, model.x + model.w / 2, model.y) })
        spineX = model.x + model.w / 2
        spineY = model.y + model.h
        const tools = Array.isArray(step.toolCalls) ? step.toolCalls : []
        for (let index = 0; index < tools.length; index += 1) {
          const tool = tools[index]
          const toolY = model.y + 4 + index * (FLOW.toolH + FLOW.toolGapY)
          nodes.push({
            id: `tool:${step.step}:${tool.callId || 'tool-' + index}`,
            kind: 'tool',
            x: toolX,
            y: toolY,
            w: FLOW.toolW,
            h: FLOW.toolH,
            step,
            tool,
            index
          })
          edges.push({
            id: `edge-tool-${step.step}-${index}`,
            kind: tool.isError ? 'error' : 'branch',
            d: branchEdgePath(model.x + model.w, model.y + model.h / 2, toolX, toolY + FLOW.toolH / 2)
          })
          spineY = Math.max(spineY, toolY + FLOW.toolH)
        }
        y = spineY + FLOW.gapY
      }

      const endNode = { id: 'end', kind: 'end', x: mainX, y, w: FLOW.mainW, h: FLOW.endH, turn }
      nodes.push(endNode)
      edges.push({ id: 'edge-end', kind: 'main', d: edgePath(spineX, spineY, mainX + FLOW.mainW / 2, endNode.y) })

      return { width, height: y + FLOW.endH + FLOW.pad, nodes, edges }
    }

    function flowNodeTitle(node) {
      if (node.kind === 'user') return '用户提问'
      if (node.kind === 'end') return '回合结束'
      if (node.kind === 'tool') return `工具调用 · ${node.tool.name || '未知工具'}`
      return `步骤 ${node.step.step} · 模型调用`
    }

    function flowField(label, value, extraClass) {
      if (typeof value !== 'string' || !value) return null
      return h(
        'div',
        { className: 'rl-field' },
        h('div', { className: 'rl-field-head' }, h('span', null, label)),
        h('pre', { className: 'rl-pre' + (extraClass ? ' ' + extraClass : '') }, value)
      )
    }

    function FlowNodeCard({ node, selected, running, clock, onSelect }) {
      const className = `rl-node rl-node-${node.kind}${selected ? ' rl-node-selected' : ''}`
      const style = { left: node.x, top: node.y, width: node.w, height: node.h }
      const onClick = () => onSelect(node.id)

      if (node.kind === 'agent') {
        const meta = node.agentMeta || {}
        const summary = (meta && meta.summary) || {}
        const expanded = Boolean(node.expanded)
        const activity = meta.activity === 'running' ? '运行中' : '已完成'
        return h(
          'button',
          { className: className + ' rl-node-agent' + (expanded ? ' rl-node-agent-open' : ''), style, onClick, title: '查看子代理（已并入全景图）' },
          h(
            'div',
            { className: 'rl-node-head' },
            h('span', { className: 'rl-node-tool-icon' }, '🤖'),
            h('span', { className: 'rl-node-tool-name' }, node.label || '子代理'),
            h('span', { className: 'rl-node-agent-merged' }, '已并入')
          ),
          h(
            'div',
            { className: 'rl-node-meta' },
            h('span', null, activity),
            h('span', null, `${summary.turns || 0} 回合 · ${summary.steps || 0} 步`),
            meta.mode ? h('span', null, agentModeLabel(meta.mode)) : null
          ),
          null
        )
      }

      if (node.kind === 'group') {
        return h(
          'div',
          {
            className: 'rl-node rl-node-group' + (selected ? ' rl-node-selected' : ''),
            style,
            title: '子代理运行图（已并入全景图）',
            role: 'button',
            tabIndex: 0,
            onClick,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick()
              }
            }
          },
          h('div', { className: 'rl-node-kicker' }, '子代理运行图'),
          h('div', { className: 'rl-node-title' }, node.label || '子代理'),
          h('div', { className: 'rl-node-meta' }, h('span', null, `${node.turnCount || 0} 回合`))
        )
      }

      if (node.kind === 'user') {
        return h(
          'button',
          { className, style, onClick, title: '查看完整提问' },
          h('div', { className: 'rl-node-kicker' }, '用户提问'),
          h('div', { className: 'rl-node-text' }, node.turn.userText || '（本回合没有记录到用户消息）')
        )
      }

      if (node.kind === 'model') {
        const step = node.step
        const busy = Boolean(step.open && running)
        return h(
          'button',
          { className, style, onClick, title: '查看该步骤详情' },
          h(
            'div',
            { className: 'rl-node-head' },
            h('span', { className: 'rl-node-kicker' }, `步骤 ${step.step}`),
            h('span', { className: 'rl-node-dot' + (busy ? ' rl-dot-busy' : step.interrupted ? ' rl-dot-warn' : '') })
          ),
          h('div', { className: 'rl-node-title' }, modelLabel(step.request && step.request.provider, step.request && step.request.model)),
          h(
            'div',
            { className: 'rl-node-meta' },
            h('span', null, fmtDuration(busy ? Math.max(0, clock - step.startedAt) : step.durationMs)),
            step.usage ? h('span', null, `↑${fmtTokens(step.usage.inputTokens)} ↓${fmtTokens(step.usage.outputTokens)}`) : null,
            step.firstTokenMs != null ? h('span', null, `首字 ${fmtDuration(step.firstTokenMs)}`) : null
          )
        )
      }

      if (node.kind === 'tool') {
        const tool = node.tool
        const busy = Boolean(running && tool.startedAt && !tool.resultAt)
        const tone = tool.isError ? ' rl-node-tool-error' : busy ? ' rl-node-tool-busy' : ''
        return h(
          'button',
          { className: className + tone, style, onClick, title: '查看工具详情' },
          h(
            'div',
            { className: 'rl-node-head' },
            h('span', { className: 'rl-node-tool-icon' }, '🔧'),
            h('span', { className: 'rl-node-tool-name' }, tool.name || '未知工具')
          ),
          h(
            'div',
            { className: 'rl-node-meta' },
            h('span', null, busy ? '进行中…' : tool.isError ? '失败' : '完成'),
            h('span', null, fmtDuration(busy ? Math.max(0, clock - tool.startedAt) : tool.durationMs))
          )
        )
      }

      const reason = node.turn.reason || { kind: 'completed' }
      return h(
        'button',
        { className, style, onClick, title: '查看回合结束信息' },
        h('div', { className: 'rl-node-kicker' }, '回合结束'),
        h('div', { className: 'rl-node-title' }, reasonLabel(reason.kind, reason.detail)),
        h(
          'div',
          { className: 'rl-node-meta' },
          h('span', null, fmtDuration(turnDuration(node.turn, running, clock))),
          h('span', null, `↑${fmtTokens(node.turn.usage && node.turn.usage.inputTokens)} ↓${fmtTokens(node.turn.usage && node.turn.usage.outputTokens)}`)
        )
      )
    }

    function FlowInspector({ turn, node, running, clock, details, actions, links, onOpenChild, onClose }) {
      const detailKey = node.step ? `${turn.turn}:${node.step.step}` : null
      const detailState = detailKey ? details[detailKey] : null
      const detail = detailState && detailState.data ? detailState.data : null
      const busy = Boolean(detailState && detailState.loading)
      const notice = detailState && detailState.error ? h('div', { className: 'rl-notice' }, `完整内容加载失败：${detailState.error}`) : null
      const childLink =
        node.kind === 'tool' && Array.isArray(links) && node.tool
          ? links.find((item) => item && item.callId === node.tool.callId) || null
          : null
      const load = () => {
        if (node.step) actions.loadDetail(turn.turn, node.step.step)
      }

      let body = null
      if (node.kind === 'user') {
        body = h('pre', { className: 'rl-pre' }, turn.userText || '（本回合没有记录到用户消息）')
      } else if (node.kind === 'end') {
        const reason = turn.reason || { kind: 'completed' }
        const usage = turn.usage || {}
        body = h(
          'div',
          null,
          h(
            'div',
            { className: 'rl-insp-chips' },
            h('span', null, `结束原因：${reasonLabel(reason.kind, reason.detail)}`),
            h('span', null, `耗时：${fmtDuration(turnDuration(turn, running, clock))}`),
            h('span', null, `输入：${fmtTokens(usage.inputTokens)}`),
            h('span', null, `输出：${fmtTokens(usage.outputTokens)}`)
          ),
          flowField('结束详情', reason.detail || '')
        )
      } else if (node.kind === 'tool') {
        const fullTool =
          detail && Array.isArray(detail.tools) ? detail.tools.find((item) => item.callId === node.tool.callId) || null : null
        const tool = fullTool || node.tool
        const done = Boolean(tool.resultAt || tool.durationMs != null)
        body = h(
          'div',
          null,
          h(
            'div',
            { className: 'rl-insp-chips' },
            h('span', null, tool.isError ? '状态：失败' : done ? '状态：完成' : '状态：进行中'),
            h('span', null, `耗时：${fmtDuration(tool.durationMs)}`)
          ),
          childLink
            ? h(
                'button',
                {
                  className: 'rl-mini rl-open-child',
                  onClick: () => onOpenChild({ id: childLink.childId, label: '', mode: 'subagent' }),
                  title: '这个工具调用创建了子代理，点击查看它的运行图'
                },
                '打开子代理运行图'
              )
            : null,
          flowField('参数', tool.arguments || ''),
          flowField('返回', tool.resultText || '', tool.isError ? 'rl-pre-error' : ''),
          flowField(
            '错误',
            tool.error ? [tool.error.name, tool.error.code, tool.error.reason].filter(Boolean).join(' · ') : ''
          ),
          flowField('附加信息', tool.meta || ''),
          node.tool.argumentsTruncated && !fullTool
            ? h('div', { className: 'rl-empty-hint' }, '参数已截断，点击上方「加载完整内容」查看全文。')
            : null,
          notice
        )
      } else {
        const step = node.step
        const request = (detail && detail.request) || step.request || {}
        const usage = (detail && detail.usage) || step.usage || {}
        const text = detail && typeof detail.text === 'string' ? detail.text : step.text
        const reasoning = detail && typeof detail.reasoning === 'string' ? detail.reasoning : step.reasoning
        body = h(
          'div',
          null,
          h(
            'div',
            { className: 'rl-insp-chips' },
            h('span', null, modelLabel(request.provider, request.model)),
            request.reason ? h('span', null, requestReasonLabel(request.reason)) : null,
            h('span', null, `耗时：${fmtDuration(step.open && running ? Math.max(0, clock - step.startedAt) : step.durationMs)}`),
            h('span', null, `输入：${fmtTokens(usage.inputTokens)}`),
            h('span', null, `输出：${fmtTokens(usage.outputTokens)}`),
            step.firstTokenMs != null ? h('span', null, `首字：${fmtDuration(step.firstTokenMs)}`) : null
          ),
          reasoning
            ? h(
                'div',
                { className: 'rl-insp-section' },
                h(
                  'div',
                  { className: 'rl-insp-label' },
                  '思考过程' + (step.open && running ? '（生成中）' : '')
                ),
                h(SmoothText, {
                  text: reasoning,
                  streaming: Boolean(step.open && running),
                  className: 'rl-pre rl-smooth'
                })
              )
            : null,
          text
            ? h(
                'div',
                { className: 'rl-insp-section' },
                h('div', { className: 'rl-insp-label' }, '模型输出'),
                h('div', { className: 'rl-md-body' }, renderMarkdown(text))
              )
            : h('div', { className: 'rl-empty-hint' }, '本步骤没有记录到模型输出。'),
          h(DivergencePanel, { turn, step, detail, actions }),
          notice
        )
      }

      return h(
        'div',
        { className: 'rl-inspector' },
        h(
          'div',
          { className: 'rl-insp-head' },
          h('span', { className: 'rl-insp-title' }, flowNodeTitle(node)),
          h('span', { className: 'rl-spacer' }),
          node.step
            ? h(
                'button',
                { className: 'rl-mini' + (busy ? ' rl-mini-loading' : ''), onClick: load, disabled: busy },
                busy ? '加载中…' : detail ? '重新加载完整内容' : '加载完整内容'
              )
            : null,
          h('button', { className: 'rl-mini', onClick: onClose, title: '关闭详情' }, '×')
        ),
        h('div', { className: 'rl-insp-body' }, body)
      )
    }

    function FlowView({ turn, loading, error, running, clock, details, actions, selectedNode, onSelect, onRetry, links, onOpenChild }) {
      const [zoom, setZoom] = React.useState(1)
      const [manual, setManual] = React.useState(false)
      const wrapRef = React.useRef(null)
      const layout = React.useMemo(() => layoutFlow(turn || { steps: [] }), [turn])

      React.useEffect(() => {
        if (manual) return undefined
        const element = wrapRef.current
        if (!element) return undefined
        const apply = () => {
          const available = element.clientWidth - 12
          if (available > 80 && layout.width > 0) setZoom(clampNumber(available / layout.width, 0.5, 1.15))
        }
        apply()
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(apply)
          observer.observe(element)
        }
        return () => {
          if (observer) observer.disconnect()
        }
      }, [layout.width, manual])

      const fit = () => {
        setManual(false)
        const element = wrapRef.current
        if (!element) return
        const available = element.clientWidth - 12
        if (available > 80) setZoom(clampNumber(available / layout.width, 0.5, 1.15))
      }

      if (!turn) {
        return h(
          'div',
          { className: 'rl-scroll' },
          loading ? h(Skeleton, null) : error ? h(ErrorState, { error, onRetry }) : h(IdleState, null)
        )
      }

      const selected = selectedNode ? layout.nodes.find((node) => node.id === selectedNode) || null : null
      const tools = countStepTools(turn.steps)

      return h(
        'div',
        { className: 'rl-flow' },
        h(
          'div',
          { className: 'rl-flow-toolbar' },
          h('span', { className: 'rl-flow-title' }, `回合 ${turn.turn} 流程`),
          h('span', { className: 'rl-flow-meta' }, `${turn.steps.length} 步 · ${tools} 工具`),
          h('span', { className: 'rl-spacer' }),
          h(
            'button',
            {
              className: 'rl-mini',
              onClick: () => {
                setManual(true)
                setZoom((value) => clampNumber(value - 0.1, 0.4, 1.6))
              },
              title: '缩小'
            },
            '－'
          ),
          h('button', { className: 'rl-mini' + (manual ? '' : ' rl-mini-on'), onClick: fit, title: '适应面板宽度' }, `${Math.round(zoom * 100)}%`),
          h(
            'button',
            {
              className: 'rl-mini',
              onClick: () => {
                setManual(true)
                setZoom((value) => clampNumber(value + 0.1, 0.4, 1.6))
              },
              title: '放大'
            },
            '＋'
          )
        ),
        h(
          'div',
          { className: 'rl-flow-scroll', ref: wrapRef },
          h(
            'div',
            { className: 'rl-flow-canvas', style: { width: layout.width * zoom, height: layout.height * zoom } },
            h(
              'div',
              {
                className: 'rl-flow-stage',
                style: { width: layout.width, height: layout.height, transform: `scale(${zoom})` }
              },
              h(
                'svg',
                {
                  className: 'rl-flow-svg',
                  width: layout.width,
                  height: layout.height,
                  viewBox: `0 0 ${layout.width} ${layout.height}`,
                  'aria-hidden': 'true'
                },
                h(
                  'defs',
                  null,
                  h(
                    'marker',
                    {
                      id: 'rl-arrow',
                      viewBox: '0 0 8 8',
                      refX: 7,
                      refY: 4,
                      markerWidth: 6,
                      markerHeight: 6,
                      orient: 'auto-start-reverse'
                    },
                    h('path', { d: 'M 0 0 L 8 4 L 0 8 z', className: 'rl-flow-arrow' })
                  )
                ),
                layout.edges.map((edge) =>
                  h('path', {
                    key: edge.id,
                    d: edge.d,
                    className: `rl-flow-edge rl-flow-edge-${edge.kind}`,
                    markerEnd: 'url(#rl-arrow)'
                  })
                )
              ),
              layout.nodes.map((node) =>
                h(FlowNodeCard, {
                  key: node.id,
                  node,
                  selected: selected ? selected.id === node.id : false,
                  running,
                  clock,
                  onSelect
                })
              )
            )
          )
        ),
        selected
          ? h(FlowInspector, {
              turn,
              node: selected,
              running,
              clock,
              details,
              actions,
              links,
              onOpenChild,
              onClose: () => onSelect(null)
            })
          : null
      )
    }

    /* ------------------------------------------------------------------ */
    /* 全景图：整段会话 + 所有子代理画在同一张图里                          */
    /* ------------------------------------------------------------------ */

    const UNIFIED = {
      pad: 18,
      mainW: 300,
      userH: 64,
      modelH: 88,
      endH: 46,
      gapY: 22,
      toolW: 190,
      toolH: 56,
      toolGapY: 8,
      branchX: 26,
      agentGapX: 96,
      agentW: 258,
      groupH: 36
    }

    function agentModeLabel(mode) {
      if (mode === 'continuable') return '可继续'
      if (mode === 'one-shot') return '一次性'
      if (mode === 'external') return '外部'
      return '未知'
    }

    /**
     * 单画布全景图：
     * - 主链把所有回合串成一条竖线（用户提问作为分隔节点，最后只有一个结束节点）；
     * - 每步模型调用在右列挂它的工具调用；
     * - 创建了子代理的工具节点显示为「子代理」节点；
     * - 展开的子代理在更右侧画出它自己的运行链（用户 → 模型步骤 → 结束）。
     */
    function layoutUnified(snapshot, links, expandedAgents, agentSnapshots, agentMeta, agentLinks) {
      const turns = snapshot && Array.isArray(snapshot.turns) ? snapshot.turns : []
      const nodes = []
      const edges = []
      const mainX = UNIFIED.pad
      const mainW = UNIFIED.mainW
      const mainCx = mainX + mainW / 2
      const toolX = mainX + mainW + UNIFIED.branchX
      const toolW = UNIFIED.toolW
      const linkByCall = new Map()
      for (const link of links || []) {
        if (link && typeof link.callId === 'string' && link.childId) linkByCall.set(link.callId, link)
      }
      const agentNodes = new Map()
      let y = UNIFIED.pad
      let spineX = mainCx
      let spineY = 0

      for (const turn of turns) {
        const user = { id: `${turn.turn}:user`, kind: 'user', x: mainX, y, w: mainW, h: UNIFIED.userH, turn }
        nodes.push(user)
        if (spineY > 0) {
          edges.push({ id: `edge-user-${turn.turn}`, kind: 'main', d: edgePath(spineX, spineY, mainCx, y) })
        }
        spineX = mainCx
        spineY = user.y + user.h
        y = spineY + UNIFIED.gapY

        for (const step of turn.steps || []) {
          const model = {
            id: `${turn.turn}:model:${step.step}`,
            kind: 'model',
            x: mainX,
            y,
            w: mainW,
            h: UNIFIED.modelH,
            step,
            turn
          }
          nodes.push(model)
          edges.push({
            id: `edge-model-${turn.turn}-${step.step}`,
            kind: 'main',
            d: edgePath(spineX, spineY, mainCx, model.y)
          })
          spineX = mainCx
          spineY = model.y + model.h

          const tools = Array.isArray(step.toolCalls) ? step.toolCalls : []
          for (let index = 0; index < tools.length; index += 1) {
            const tool = tools[index]
            const toolY = model.y + 4 + index * (UNIFIED.toolH + UNIFIED.toolGapY)
            const link = tool && tool.callId ? linkByCall.get(tool.callId) : null
            const childId = link && link.childId ? link.childId : null
            const base = {
              id: `${turn.turn}:tool:${step.step}:${tool.callId || 'tool-' + index}`,
              x: toolX,
              y: toolY,
              w: toolW,
              h: UNIFIED.toolH,
              step,
              tool,
              turn,
              index
            }
            const node = childId
              ? {
                  ...base,
                  kind: 'agent',
                  childId,
                  label: (agentMeta[childId] && agentMeta[childId].label) || `子代理 ${shortId(childId)}`,
                  agentMeta: agentMeta[childId] || null,
                  expanded: Boolean(expandedAgents[childId] && agentSnapshots[childId])
                }
              : { ...base, kind: 'tool' }
            nodes.push(node)
            if (childId) agentNodes.set(childId, node)
            edges.push({
              id: `edge-tool-${turn.turn}-${step.step}-${index}`,
              kind: childId ? 'agent' : tool.isError ? 'error' : 'branch',
              d: branchEdgePath(mainX + mainW, model.y + model.h / 2, toolX, toolY + UNIFIED.toolH / 2)
            })
            spineY = Math.max(spineY, toolY + UNIFIED.toolH)
          }
          y = spineY + UNIFIED.gapY
        }
      }

      const lastTurn = turns.length ? turns[turns.length - 1] : null
      const end = {
        id: 'end',
        kind: 'end',
        x: mainX,
        y,
        w: mainW,
        h: UNIFIED.endH,
        turn: lastTurn
      }
      nodes.push(end)
      edges.push({ id: 'edge-end', kind: 'main', d: edgePath(spineX, spineY, mainCx, end.y) })

      let width = toolX + toolW + UNIFIED.pad
      let height = y + UNIFIED.endH + UNIFIED.pad

      const MAX_AGENT_DEPTH = 3
      const drawnAgents = new Set()
      const agentX = toolX + toolW + UNIFIED.agentGapX
      const allAgentIds = Array.from(agentNodes.keys())

      const drawAgentChain = (childId, columnX, startY, depth, anchorNode) => {
        if (!childId || drawnAgents.has(childId) || depth > MAX_AGENT_DEPTH) return startY
        const childSnapshot = agentSnapshots && agentSnapshots[childId]
        if (!childSnapshot) return startY
        drawnAgents.add(childId)
        const childTurns = Array.isArray(childSnapshot.turns) ? childSnapshot.turns : []
        const meta = (agentMeta && agentMeta[childId]) || {}
        const group = {
          id: `agent:${childId}`,
          kind: 'group',
          x: columnX,
          y: startY,
          w: UNIFIED.agentW,
          h: UNIFIED.groupH,
          childId,
          label: meta.label || `子代理 ${shortId(childId)}`,
          turnCount: childTurns.length,
          depth
        }
        nodes.push(group)
        width = Math.max(width, columnX + UNIFIED.agentW + UNIFIED.pad)
        if (anchorNode) {
          edges.push({
            id: `edge-agent-${childId}`,
            kind: 'agent',
            d: branchEdgePath(
              anchorNode.x + anchorNode.w,
              anchorNode.y + anchorNode.h / 2,
              columnX,
              startY + UNIFIED.groupH / 2
            )
          })
        }
        let cursorY = startY + UNIFIED.groupH + 12
        const childX = columnX + 20
        const childW = UNIFIED.agentW - 20
        const innerLinks = agentLinks && Array.isArray(agentLinks[childId]) ? agentLinks[childId] : []
        const linkByCall = new Map()
        for (const link of innerLinks) {
          if (link && typeof link.callId === 'string' && link.childId) linkByCall.set(link.callId, link)
        }
        let prevX = null
        let prevY = null
        let bottom = cursorY
        for (const turn of childTurns) {
          const childUser = {
            id: `agent:${childId}:${turn.turn}:user`,
            kind: 'user',
            x: childX,
            y: cursorY,
            w: childW,
            h: 52,
            turn,
            compact: true,
            childOf: childId,
            depth
          }
          nodes.push(childUser)
          if (prevY != null) {
            edges.push({
              id: `edge-${childUser.id}`,
              kind: 'agent',
              d: edgePath(prevX, prevY, childX + childW / 2, cursorY)
            })
          }
          prevX = childX + childW / 2
          prevY = cursorY + childUser.h
          cursorY = prevY + 12
          bottom = Math.max(bottom, cursorY)
          for (const step of turn.steps || []) {
            const childModel = {
              id: `agent:${childId}:${turn.turn}:model:${step.step}`,
              kind: 'model',
              x: childX,
              y: cursorY,
              w: childW,
              h: 68,
              step,
              turn,
              childOf: childId,
              depth
            }
            nodes.push(childModel)
            edges.push({
              id: `edge-${childModel.id}`,
              kind: 'agent',
              d: edgePath(prevX, prevY, childX + childW / 2, cursorY)
            })
            const modelY = cursorY
            prevX = childX + childW / 2
            prevY = cursorY + childModel.h
            cursorY = prevY + 12
            bottom = Math.max(bottom, cursorY)

            const tools = Array.isArray(step.toolCalls) ? step.toolCalls : []
            const nestedX = columnX + UNIFIED.agentW + UNIFIED.agentGapX
            let nestedY = modelY
            for (let index = 0; index < tools.length; index += 1) {
              const tool = tools[index]
              const link = tool && tool.callId ? linkByCall.get(tool.callId) : null
              const grandId = link && link.childId ? link.childId : null
              if (!grandId) continue
              const grandMeta = (agentMeta && agentMeta[grandId]) || {}
              const grandExpanded = Boolean(
                expandedAgents && expandedAgents[grandId] && agentSnapshots && agentSnapshots[grandId]
              )
              const nestedNode = {
                id: `agent:${childId}:${turn.turn}:${step.step}:${tool.callId || 'tool-' + index}`,
                kind: 'agent',
                x: nestedX,
                y: nestedY,
                w: UNIFIED.toolW + 34,
                h: UNIFIED.toolH,
                step,
                tool,
                turn,
                childId: grandId,
                label: grandMeta.label || `子代理 ${shortId(grandId)}`,
                agentMeta: grandMeta || null,
                expanded: grandExpanded,
                childOf: childId,
                depth: depth + 1
              }
              nodes.push(nestedNode)
              width = Math.max(width, nestedX + nestedNode.w + UNIFIED.pad)
              edges.push({
                id: `edge-${nestedNode.id}`,
                kind: 'agent',
                d: branchEdgePath(childX + childW, modelY + 34, nestedX, nestedY + UNIFIED.toolH / 2)
              })
              nestedY += UNIFIED.toolH + UNIFIED.toolGapY
              bottom = Math.max(bottom, nestedY)
              if (grandExpanded && depth < MAX_AGENT_DEPTH) {
                const branchBottom = drawAgentChain(
                  grandId,
                  nestedX + nestedNode.w + UNIFIED.agentGapX,
                  modelY,
                  depth + 1,
                  nestedNode
                )
                bottom = Math.max(bottom, branchBottom)
              }
            }
          }
          cursorY = Math.max(cursorY, bottom)
          cursorY += 6
          bottom = Math.max(bottom, cursorY)
        }
        const childEnd = {
          id: `agent:${childId}:end`,
          kind: 'end',
          x: childX,
          y: cursorY,
          w: childW,
          h: 40,
          turn: childTurns.length ? childTurns[childTurns.length - 1] : null,
          childOf: childId,
          depth
        }
        nodes.push(childEnd)
        if (prevY != null) {
          edges.push({
            id: `edge-${childEnd.id}`,
            kind: 'agent',
            d: edgePath(prevX, prevY, childX + childW / 2, cursorY)
          })
        }
        bottom = Math.max(bottom, cursorY + 40)
        return bottom
      }

      let agentY = UNIFIED.pad
      for (const childId of allAgentIds) {
        if (!(expandedAgents && expandedAgents[childId])) continue
        if (!(agentSnapshots && agentSnapshots[childId])) continue
        agentY = drawAgentChain(childId, agentX, agentY, 1, agentNodes.get(childId)) + 34
        height = Math.max(height, agentY + UNIFIED.pad)
      }
      return { width, height, nodes, edges }
    }

    function FlowAgentInspector({ node, agentMeta, agentSnapshots, agentErrors, onOpenChild, onClose }) {
      const childId = node.childId
      const meta = node.agentMeta || (agentMeta && agentMeta[childId]) || {}
      const snapshot = childId ? agentSnapshots[childId] : null
      const error = childId ? agentErrors[childId] : null
      const summary = (meta && meta.summary) || {}
      const childRunning = Boolean(snapshot && snapshot.session && snapshot.session.running)
      return h(
        'div',
        { className: 'rl-inspector' },
        h(
          'div',
          { className: 'rl-insp-head' },
          h('span', { className: 'rl-insp-title' }, `子代理 · ${node.label || shortId(childId || '')}`),
          h('span', { className: 'rl-spacer' }),
          childId ? h('span', { className: 'rl-insp-merged' }, '已并入全景图') : null,
          childId
            ? h(
                'button',
                {
                  className: 'rl-mini',
                  onClick: () =>
                    onOpenChild({
                      id: childId,
                      label: meta.label || node.label || '',
                      mode: meta.mode || 'unknown'
                    }),
                  title: '把这个子代理作为独立会话打开'
                },
                '单独打开'
              )
            : null,
          h('button', { className: 'rl-mini', onClick: onClose, title: '关闭详情' }, '×')
        ),
        h(
          'div',
          { className: 'rl-insp-body' },
          h(
            'div',
            { className: 'rl-insp-chips' },
            h('span', null, `模式：${agentModeLabel(meta.mode)}`),
            h('span', null, `状态：${meta.activity === 'running' || childRunning ? '运行中' : '已完成'}`),
            h('span', null, `回合：${summary.turns || 0}`),
            h('span', null, `步骤：${summary.steps || 0}`),
            h('span', null, `工具：${summary.toolCalls || 0}`),
            summary.durationMs != null ? h('span', null, `耗时：${fmtDuration(summary.durationMs)}`) : null
          ),
          error ? h('div', { className: 'rl-notice' }, `子代理快照加载失败：${error}`) : null,
          snapshot
            ? h(
                'div',
                { className: 'rl-insp-section' },
                h('div', { className: 'rl-insp-label' }, '子代理运行摘要'),
                h(
                  'div',
                  { className: 'rl-insp-chips' },
                  h('span', null, `事件：${snapshot.session ? snapshot.session.eventCount : 0}`),
                  h('span', null, `结束：${snapshot.session && snapshot.session.running ? '仍在运行' : '已结束'}`),
                  h('span', null, `模型：${modelLabel(snapshot.model && snapshot.model.provider, snapshot.model && snapshot.model.model)}`)
                )
              )
            : childId
              ? h('div', { className: 'rl-empty-hint' }, '正在读取子代理运行图…（若长时间无内容，可点“单独打开”查看）')
              : h('div', { className: 'rl-empty-hint' }, '没有关联的子代理会话。'),
          flowField('最后提问', summary.lastUserText || ''),
          flowField('最后输出', summary.lastAssistantText || '')
        )
      )
    }

    function UnifiedView({
      snapshot,
      loading,
      error,
      running,
      clock,
      details,
      actions,
      selectedNode,
      onSelect,
      onRetry,
      links,
      agentMeta,
      agentLinks,
      expandedAgents,
      agentSnapshots,
      agentErrors,
      onOpenChild
    }) {
      const [zoom, setZoom] = React.useState(1)
      const [manual, setManual] = React.useState(false)
      const wrapRef = React.useRef(null)
      const layout = React.useMemo(
        () => layoutUnified(snapshot, links, expandedAgents, agentSnapshots, agentMeta, agentLinks),
        [snapshot, links, expandedAgents, agentSnapshots, agentMeta, agentLinks]
      )

      React.useEffect(() => {
        if (manual) return undefined
        const element = wrapRef.current
        if (!element) return undefined
        const apply = () => {
          const available = element.clientWidth - 12
          if (available > 80 && layout.width > 0) setZoom(clampNumber(available / layout.width, 0.4, 1.1))
        }
        apply()
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(apply)
          observer.observe(element)
        }
        return () => {
          if (observer) observer.disconnect()
        }
      }, [layout.width, manual])

      const fit = () => {
        setManual(false)
        const element = wrapRef.current
        if (!element) return
        const available = element.clientWidth - 12
        if (available > 80) setZoom(clampNumber(available / layout.width, 0.4, 1.1))
      }

      if (!snapshot) {
        return h(
          'div',
          { className: 'rl-scroll' },
          loading ? h(Skeleton, null) : error ? h(ErrorState, { error, onRetry }) : h(IdleState, null)
        )
      }

      const selected = selectedNode ? layout.nodes.find((node) => node.id === selectedNode) || null : null
      const handleSelect = (id) => {
        onSelect(id)
      }
      const isAgentNode = Boolean(selected && (selected.kind === 'agent' || selected.kind === 'group'))
      const turns = Array.isArray(snapshot.turns) ? snapshot.turns : []
      let stepCount = 0
      let toolCount = 0
      for (const turn of turns) {
        stepCount += Array.isArray(turn.steps) ? turn.steps.length : 0
        toolCount += countStepTools(turn.steps)
      }

      const scrollToY = (y) => {
        const element = wrapRef.current
        if (!element) return
        element.scrollTo({ top: Math.max(0, y * zoom - 24), behavior: 'smooth' })
      }
      const jumpToTurn = (turnNo) => {
        const node = layout.nodes.find(
          (item) => item.kind === 'user' && !item.childOf && item.turn && item.turn.turn === turnNo
        )
        if (node) scrollToY(node.y)
      }
      const scrollToLatest = () => {
        const element = wrapRef.current
        if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
      }

      return h(
        'div',
        { className: 'rl-flow rl-unified' },
        h(
          'div',
          { className: 'rl-flow-toolbar' },
          h('span', { className: 'rl-flow-title' }, '全程全景图'),
          h('span', { className: 'rl-flow-meta' }, `${turns.length} 回合 · ${stepCount} 步 · ${toolCount} 工具`),
          h(
            'select',
            {
              className: 'rl-flow-jump',
              value: '',
              title: '定位到指定回合',
              onChange: (event) => {
                const value = Number(event.target.value)
                if (Number.isInteger(value) && value > 0) jumpToTurn(value)
                event.target.value = ''
              }
            },
            h('option', { value: '' }, '跳到回合…'),
            turns.map((turn) => h('option', { key: turn.turn, value: turn.turn }, `回合 ${turn.turn}`))
          ),
          h('button', { className: 'rl-mini', onClick: scrollToLatest, title: '定位到最新节点' }, '最新'),
          h('span', { className: 'rl-spacer' }),
          h(
            'button',
            {
              className: 'rl-mini',
              onClick: () => {
                setManual(true)
                setZoom((value) => clampNumber(value - 0.1, 0.3, 1.6))
              },
              title: '缩小'
            },
            '－'
          ),
          h('button', { className: 'rl-mini' + (manual ? '' : ' rl-mini-on'), onClick: fit, title: '适应面板宽度' }, `${Math.round(zoom * 100)}%`),
          h(
            'button',
            {
              className: 'rl-mini',
              onClick: () => {
                setManual(true)
                setZoom((value) => clampNumber(value + 0.1, 0.3, 1.6))
              },
              title: '放大'
            },
            '＋'
          )
        ),
        h(
          'div',
          { className: 'rl-flow-scroll', ref: wrapRef },
          h(
            'div',
            { className: 'rl-flow-canvas', style: { width: layout.width * zoom, height: layout.height * zoom } },
            h(
              'div',
              {
                className: 'rl-flow-stage',
                style: { width: layout.width, height: layout.height, transform: `scale(${zoom})` }
              },
              h(
                'svg',
                {
                  className: 'rl-flow-svg',
                  width: layout.width,
                  height: layout.height,
                  viewBox: `0 0 ${layout.width} ${layout.height}`,
                  'aria-hidden': 'true'
                },
                h(
                  'defs',
                  null,
                  h(
                    'marker',
                    {
                      id: 'rl-arrow',
                      viewBox: '0 0 8 8',
                      refX: 7,
                      refY: 4,
                      markerWidth: 6,
                      markerHeight: 6,
                      orient: 'auto-start-reverse'
                    },
                    h('path', { d: 'M 0 0 L 8 4 L 0 8 z', className: 'rl-flow-arrow' })
                  )
                ),
                layout.edges.map((edge) =>
                  h('path', {
                    key: edge.id,
                    d: edge.d,
                    className: `rl-flow-edge rl-flow-edge-${edge.kind}`,
                    markerEnd: 'url(#rl-arrow)'
                  })
                )
              ),
              layout.nodes.map((node) =>
                h(FlowNodeCard, {
                  key: node.id,
                  node,
                  selected: selected ? selected.id === node.id : false,
                  running,
                  clock,
                  onSelect: handleSelect
                })
              )
            )
          )
        ),
        selected && isAgentNode
          ? h(FlowAgentInspector, {
              node: selected,
              agentMeta,
              agentSnapshots,
              agentErrors,
              onOpenChild,
              onClose: () => onSelect(null)
            })
          : selected && selected.childOf
            ? h(
                'div',
                { className: 'rl-inspector' },
                h(
                  'div',
                  { className: 'rl-insp-head' },
                  h('span', { className: 'rl-insp-title' }, '子代理运行图 · 节点'),
                  h('span', { className: 'rl-spacer' }),
                  h('button', { className: 'rl-mini', onClick: () => onSelect(null), title: '关闭详情' }, '×')
                ),
                h(
                  'div',
                  { className: 'rl-insp-body' },
                  h(
                    'div',
                    { className: 'rl-empty-hint' },
                    '这是子代理运行图里的节点；完整参数 / 返回 / 思考内容请单独打开该子代理查看。'
                  ),
                  h(
                    'button',
                    {
                      className: 'rl-mini',
                      onClick: () =>
                        onOpenChild({
                          id: selected.childOf,
                          label: (agentMeta[selected.childOf] && agentMeta[selected.childOf].label) || '',
                          mode: (agentMeta[selected.childOf] && agentMeta[selected.childOf].mode) || 'unknown'
                        })
                    },
                    '单独打开该子代理'
                  )
                )
              )
            : selected && selected.turn
            ? h(FlowInspector, {
                turn: selected.turn,
                node: selected,
                running,
                clock,
                details,
                actions,
                links,
                onOpenChild,
                onClose: () => onSelect(null)
              })
            : null
      )
    }

    /* ------------------------------------------------------------------ */
    /* 丝滑文本、偏离检查与子代理条                                         */
    /* ------------------------------------------------------------------ */

    function SmoothText({ text, streaming, className }) {
      const target = typeof text === 'string' ? text : ''
      const [shown, setShown] = React.useState(target)
      const shownRef = React.useRef(target)

      React.useEffect(() => {
        shownRef.current = shown
      }, [shown])

      React.useEffect(() => {
        if (!streaming) {
          if (shownRef.current !== target) setShown(target)
          return undefined
        }
        let index = Math.min(shownRef.current.length, target.length)
        if (index >= target.length) {
          if (shownRef.current !== target) setShown(target)
          return undefined
        }
        const step = Math.max(1, Math.ceil((target.length - index) / 28))
        const timer = setInterval(() => {
          index = Math.min(target.length, index + step)
          setShown(target.slice(0, index))
          if (index >= target.length) clearInterval(timer)
        }, 16)
        return () => clearInterval(timer)
      }, [target, streaming])

      return h('div', { className: (className || '') + (streaming ? ' rl-smooth-live' : '') }, shown)
    }

    function analyzeDivergence(turn, step) {
      const notes = []
      if (!turn || !step) return notes

      const steps = Array.isArray(turn.steps) ? turn.steps : []
      const calls = []
      for (const item of steps) {
        for (const call of item.toolCalls || []) calls.push(call)
      }

      const counts = new Map()
      for (const call of calls) {
        const key = `${call.name || ''}|${String(call.arguments || '').slice(0, 120)}`
        counts.set(key, (counts.get(key) || 0) + 1)
      }
      let repeated = 0
      for (const value of counts.values()) if (value > 1) repeated += value - 1
      if (repeated > 0) {
        notes.push({ level: 'warn', text: `本回合有 ${repeated} 次相同工具与参数重复调用，可能在原地打转。` })
      }

      const errors = calls.filter((call) => call.isError).length
      if (errors >= 2) {
        notes.push({ level: 'warn', text: `本回合工具失败 ${errors} 次，检查是否思路受阻。` })
      }

      const text = step.text || ''
      const reasoning = step.reasoning || ''
      if (reasoning && text && reasoning.length > text.length * 4 && text.length < 120) {
        notes.push({ level: 'info', text: '思考篇幅远大于输出，留意是否只分析未落地。' })
      }

      if (turn.userText && (text || reasoning)) {
        const words = String(turn.userText).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []
        const unique = Array.from(new Set(words)).slice(0, 8)
        if (unique.length) {
          const haystack = (text + '\n' + reasoning).toLowerCase()
          const hit = unique.filter((word) => haystack.includes(word)).length
          if (hit === 0) {
            notes.push({ level: 'warn', text: '输出与思考里没有出现用户问题中的关键词，可能偏离目标。' })
          } else if (hit <= Math.floor(unique.length / 3)) {
            notes.push({ level: 'info', text: '用户问题关键词覆盖较少，建议核对是否答到点上。' })
          }
        }
      }

      if (step.interrupted) notes.push({ level: 'warn', text: '该步骤被中断。' })
      if (!text && !step.open && step.toolCalls && step.toolCalls.length) {
        notes.push({ level: 'info', text: '本步骤只调用了工具、没有文本输出。' })
      }
      return notes
    }

    function divergenceKeywords(turn, step) {
      if (!turn || !turn.userText || !step) return []
      const matches = String(turn.userText).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []
      const unique = Array.from(new Set(matches)).slice(0, 10)
      if (!unique.length) return []
      const haystack = `${step.text || ''}\n${step.reasoning || ''}`.toLowerCase()
      const result = []
      for (const word of unique) {
        const hit = haystack.includes(word)
        const hitCount = result.filter((item) => item.hit).length
        const missCount = result.length - hitCount
        if (hit && hitCount >= 6) continue
        if (!hit && missCount >= 6) continue
        result.push({ word, hit })
      }
      return result
    }

    function DivergenceCompare({ turn, step, detail, actions }) {
      const [open, setOpen] = React.useState(false)
      const [fullReasoning, setFullReasoning] = React.useState(false)
      const [fullText, setFullText] = React.useState(false)
      const reasoning = (detail && typeof detail.reasoning === 'string' ? detail.reasoning : step.reasoning) || ''
      const output = (detail && typeof detail.text === 'string' ? detail.text : step.text) || ''
      if (!reasoning || !output) return null
      const ratio = output.length ? (reasoning.length / output.length).toFixed(1) : '—'
      const turnNo = turn && typeof turn.turn === 'number' ? turn.turn : undefined
      const preview = (text, full) => {
        const limit = full ? text.length : 900
        return text.slice(0, limit) + (text.length > limit ? '\n…（已截断，点「展开」看全文）' : '')
      }
      const needDetail = !detail && Boolean(step.textTruncated || step.reasoningTruncated)
      return h(
        'div',
        { className: 'rl-compare' },
        h(
          'button',
          { className: 'rl-subtoggle', onClick: () => setOpen((value) => !value) },
          (open ? '▾ ' : '▸ ') +
            `思路 vs 输出对照（思考 ${reasoning.length} 字 / 输出 ${output.length} 字 · 比例 ${ratio}）`
        ),
        open
          ? h(
              'div',
              null,
              needDetail && actions
                ? h(
                    'button',
                    {
                      className: 'rl-link rl-link-inline',
                      onClick: () => actions.loadDetail(turnNo, step.step)
                    },
                    '加载完整内容后对照'
                  )
                : null,
              h(
                'div',
                { className: 'rl-compare-grid' },
                h(
                  'div',
                  { className: 'rl-compare-col' },
                  h(
                    'div',
                    { className: 'rl-compare-head' },
                    h('span', null, '思考过程'),
                    h('button', { className: 'rl-link', onClick: () => setFullReasoning((value) => !value) }, fullReasoning ? '收起' : '展开')
                  ),
                  h('pre', { className: 'rl-compare-body' }, preview(reasoning, fullReasoning))
                ),
                h(
                  'div',
                  { className: 'rl-compare-col' },
                  h(
                    'div',
                    { className: 'rl-compare-head' },
                    h('span', null, '模型输出'),
                    h('button', { className: 'rl-link', onClick: () => setFullText((value) => !value) }, fullText ? '收起' : '展开')
                  ),
                  h('pre', { className: 'rl-compare-body' }, preview(output, fullText))
                )
              )
            )
          : null
      )
    }

    function DivergencePanel({ turn, step, detail, actions }) {
      const notes = React.useMemo(() => analyzeDivergence(turn, step), [turn, step])
      const keywords = React.useMemo(() => divergenceKeywords(turn, step), [turn, step])
      const reasoning = (detail && typeof detail.reasoning === 'string' ? detail.reasoning : step.reasoning) || ''
      const output = (detail && typeof detail.text === 'string' ? detail.text : step.text) || ''
      if (!notes.length && !keywords.length && !(reasoning && output)) return null
      return h(
        'div',
        { className: 'rl-divergence' },
        h('div', { className: 'rl-insp-label' }, '思路偏离检查'),
        notes.map((note, index) =>
          h(
            'div',
            { key: index, className: 'rl-divergence-item rl-divergence-' + note.level },
            (note.level === 'warn' ? '⚠ ' : '· ') + note.text
          )
        ),
        keywords.length
          ? h(
              'div',
              { className: 'rl-kw-row' },
              h('span', { className: 'rl-kw-label' }, '问题关键词'),
              keywords.map((item, index) =>
                h('span', { key: index, className: 'rl-kw' + (item.hit ? ' rl-kw-hit' : ' rl-kw-miss') }, item.word)
              )
            )
          : null,
        h(DivergenceCompare, { turn, step, detail, actions }),
        h('div', { className: 'rl-divergence-note' }, '启发式提示，仅供参考。')
      )
    }

    function SubagentBar({ trail, subagents, error, onOpen, onExit }) {
      const list = Array.isArray(subagents) ? subagents : []
      const hasTrail = trail.length > 0
      if (!hasTrail && list.length === 0 && !error) return null

      return h(
        'div',
        { className: 'rl-subagents' },
        h(
          'div',
          { className: 'rl-subagent-trail' },
          h(
            'button',
            {
              className: 'rl-trail-link' + (!hasTrail ? ' rl-trail-current' : ''),
              onClick: () => onExit(0),
              title: '回到主会话'
            },
            '主会话'
          ),
          trail.map((entry, index) =>
            h(
              'span',
              { key: entry.id, className: 'rl-trail-item' },
              h('span', { className: 'rl-trail-sep' }, '›'),
              h(
                'button',
                {
                  className: 'rl-trail-link' + (index === trail.length - 1 ? ' rl-trail-current' : ''),
                  onClick: () => onExit(index + 1),
                  title: entry.id
                },
                entry.label || shortId(entry.id)
              )
            )
          ),
          hasTrail
            ? h('button', { className: 'rl-mini', onClick: () => onExit(trail.length - 1) }, '返回上级')
            : null
        ),
        error ? h('span', { className: 'rl-subagent-error' }, `子代理读取失败：${error}`) : null,
        list.length
          ? h(
              'div',
              { className: 'rl-subagent-chips' },
              h('span', { className: 'rl-subagent-label' }, `子代理 ${list.length}`),
              list.map((entry) =>
                h(
                  'button',
                  {
                    key: entry.id,
                    className: 'rl-subagent-chip' + (entry.activity === 'running' ? ' rl-subagent-running' : ''),
                    onClick: () => onOpen(entry),
                    title: `${entry.id} · ${entry.mode || 'unknown'}`
                  },
                  h('span', { className: 'rl-subagent-dot' + (entry.activity === 'running' ? ' rl-dot-busy' : '') }),
                  entry.label || shortId(entry.id),
                  entry.summary
                    ? h('span', { className: 'rl-subagent-meta' }, `${entry.summary.steps}步 · ${entry.summary.toolCalls}工具`)
                    : null,
                  entry.hasChildren ? h('span', { className: 'rl-subagent-nested' }, '↳') : null
                )
              )
            )
          : null
      )
    }

    /* ------------------------------------------------------------------ */
    /* 会话视图（聊天消息）                                                */
    /* ------------------------------------------------------------------ */

    function ChatView({ snapshot, loading, error, running, clock, details, actions, onJumpStep, onRetry }) {
      if (!snapshot) {
        return h(
          'div',
          { className: 'rl-scroll' },
          loading ? h(Skeleton, null) : error ? h(ErrorState, { error, onRetry }) : h(IdleState, null)
        )
      }
      const turns = Array.isArray(snapshot.turns) ? snapshot.turns : []
      if (turns.length === 0) {
        return h('div', { className: 'rl-scroll' }, h(EmptyState, { query: '', filter: 'all' }))
      }
      const lastTurn = turns[turns.length - 1].turn
      return h(
        'div',
        { className: 'rl-chat' },
        turns.map((turn) =>
          h(ChatTurn, {
            key: turn.turn,
            turn,
            isLast: turn.turn === lastTurn,
            running,
            clock,
            details,
            actions,
            onJumpStep
          })
        )
      )
    }

    function ChatTurn({ turn, isLast, running, clock, details, actions, onJumpStep }) {
      const reason = turn.reason
      return h(
        'section',
        { className: 'rl-chat-turn' + (isLast && turn.open ? ' rl-chat-turn-live' : ''), 'data-turn': turn.turn },
        h(
          'div',
          { className: 'rl-chat-turn-head' },
          h('span', { className: 'rl-turn-no' }, `回合 ${turn.turn}`),
          reason ? h('span', { className: 'rl-tag ' + reasonTone(reason.kind) }, reasonLabel(reason.kind, reason.detail)) : null,
          turn.open ? h('span', { className: 'rl-tag rl-tag-run' }, '进行中') : null,
          h('span', { className: 'rl-turn-meta' }, `${(turn.steps || []).length} 步 · ${fmtDuration(turnDuration(turn, running, clock))}`)
        ),
        turn.userText
          ? h(
              'div',
              { className: 'rl-bubble rl-bubble-user' },
              h('div', { className: 'rl-bubble-role' }, '你'),
              h('div', { className: 'rl-bubble-body' }, turn.userText)
            )
          : null,
        (turn.steps || []).map((step) =>
          h(ChatStep, { key: step.step, turn, step, running, clock, details, actions, onJumpStep })
        )
      )
    }

    function ChatStep({ turn, step, running, clock, details, actions, onJumpStep }) {
      const [reasonOpen, setReasonOpen] = React.useState(false)
      const detailKey = `${turn.turn}:${step.step}`
      const detailState = details[detailKey]
      const detail = detailState && detailState.data ? detailState.data : null
      const streaming = Boolean(step.open && running)
      const text = detail && typeof detail.text === 'string' ? detail.text : step.text
      const reasoning = detail && typeof detail.reasoning === 'string' ? detail.reasoning : step.reasoning
      const request = (detail && detail.request) || step.request || {}

      return h(
        'div',
        { className: 'rl-bubble rl-bubble-assistant' + (streaming ? ' rl-bubble-live' : '') },
        h(
          'div',
          { className: 'rl-bubble-role' },
          h('span', null, `步骤 ${step.step} · ${modelLabel(request.provider, request.model)}`),
          h(
            'button',
            { className: 'rl-bubble-jump', onClick: () => onJumpStep(turn.turn, step.step, null), title: '在流程图中定位这一步' },
            '在流程图中查看'
          )
        ),
        reasoning
          ? h(
              'div',
              { className: 'rl-thinking' + (streaming ? ' rl-thinking-live' : '') },
              h(
                'button',
                { className: 'rl-thinking-toggle', onClick: () => setReasonOpen((value) => !value) },
                `${reasonOpen ? '▾' : '▸'} 思考过程${streaming ? '（生成中）' : ''}`
              ),
              reasonOpen ? h(SmoothText, { text: reasoning, streaming, className: 'rl-thinking-body' }) : null
            )
          : null,
        text
          ? h('div', { className: 'rl-chat-text' }, h(Markdown, { text }))
          : streaming
            ? h('div', { className: 'rl-typing' }, '正在生成…')
            : h('div', { className: 'rl-empty-hint' }, '本步骤没有文本输出。'),
        step.textTruncated && !detail
          ? h(
              'button',
              { className: 'rl-mini', onClick: () => actions.loadDetail(turn.turn, step.step) },
              detailState && detailState.loading ? '加载中…' : '加载完整内容'
            )
          : null,
        step.toolCalls && step.toolCalls.length
          ? h(
              'div',
              { className: 'rl-chat-tools' },
              step.toolCalls.map((tool, index) =>
                h(
                  'button',
                  {
                    key: tool.callId || 'tool-' + index,
                    className: 'rl-chat-tool' + (tool.isError ? ' rl-chat-tool-error' : ''),
                    onClick: () => onJumpStep(turn.turn, step.step, tool.callId || null),
                    title: '在流程图中定位这个工具调用'
                  },
                  '🔧 ',
                  tool.name || '未知工具',
                  tool.isError ? ' · 失败' : tool.durationMs != null ? ` · ${fmtDuration(tool.durationMs)}` : ''
                )
              )
            )
          : null,
        h(DivergencePanel, { turn, step, detail, actions })
      )
    }

    /* ------------------------------------------------------------------ */
    /* 泳道视图                                                            */
    /* ------------------------------------------------------------------ */

    const SWIM = {
      pad: 16,
      labelW: 62,
      laneGap: 12,
      userH: 62,
      modelH: 92,
      toolH: 56,
      endH: 52,
      modelW: 236,
      toolW: 148,
      toolGapX: 8,
      colGap: 26
    }

    function layoutSwimlane(turn) {
      const steps = turn && Array.isArray(turn.steps) ? turn.steps : []
      const userY = SWIM.pad
      const modelY = userY + SWIM.userH + SWIM.laneGap
      const toolY = modelY + SWIM.modelH + SWIM.laneGap
      const endY = toolY + SWIM.toolH + SWIM.laneGap
      const lanes = [
        { id: 'user', label: '用户', y: userY, h: SWIM.userH },
        { id: 'model', label: '模型', y: modelY, h: SWIM.modelH },
        { id: 'tool', label: '工具', y: toolY, h: SWIM.toolH },
        { id: 'end', label: '收尾', y: endY, h: SWIM.endH }
      ]

      const left = SWIM.pad + SWIM.labelW + 10
      const nodes = []
      const edges = []
      const user = { id: 'user', kind: 'user', x: left, y: userY + 4, w: SWIM.modelW, h: SWIM.userH - 8, turn }
      nodes.push(user)

      let columnX = left + SWIM.modelW + SWIM.colGap
      let previousModel = null
      let lastModel = null
      let lastColumn = null

      for (const step of steps) {
        const tools = Array.isArray(step.toolCalls) ? step.toolCalls : []
        const colW = Math.max(
          SWIM.modelW,
          tools.length ? tools.length * (SWIM.toolW + SWIM.toolGapX) - SWIM.toolGapX : 0
        )
        const model = { id: `model:${step.step}`, kind: 'model', x: columnX, y: modelY, w: SWIM.modelW, h: SWIM.modelH, step }
        nodes.push(model)
        if (previousModel) {
          edges.push({
            id: `swim-step-${step.step}`,
            kind: 'main',
            d: edgePath(previousModel.x + previousModel.w, previousModel.y + previousModel.h / 2, model.x, model.y + model.h / 2)
          })
        } else {
          edges.push({
            id: 'swim-user',
            kind: 'main',
            d: edgePath(user.x + user.w / 2, user.y + user.h, model.x + model.w / 2, model.y)
          })
        }
        tools.forEach((tool, index) => {
          const toolX = columnX + index * (SWIM.toolW + SWIM.toolGapX)
          nodes.push({
            id: `tool:${step.step}:${tool.callId || 'tool-' + index}`,
            kind: 'tool',
            x: toolX,
            y: toolY,
            w: SWIM.toolW,
            h: SWIM.toolH,
            step,
            tool,
            index
          })
          edges.push({
            id: `swim-tool-${step.step}-${index}`,
            kind: tool.isError ? 'error' : 'branch',
            d: branchEdgePath(model.x + model.w / 2, model.y + model.h, toolX + SWIM.toolW / 2, toolY)
          })
        })
        lastColumn = { x: columnX, w: colW }
        previousModel = model
        lastModel = model
        columnX += colW + SWIM.colGap
      }

      const endX = lastColumn ? lastColumn.x + Math.max(0, (lastColumn.w - SWIM.modelW) / 2) : left
      const endNode = { id: 'end', kind: 'end', x: endX, y: endY + 2, w: SWIM.modelW, h: SWIM.endH - 6, turn }
      nodes.push(endNode)
      if (lastModel) {
        edges.push({
          id: 'swim-end',
          kind: 'main',
          d: edgePath(lastModel.x + lastModel.w / 2, lastModel.y + lastModel.h, endNode.x + endNode.w / 2, endNode.y)
        })
      }

      return {
        width: Math.max(columnX - SWIM.colGap + SWIM.pad, left + SWIM.modelW + SWIM.pad),
        height: endY + SWIM.endH + SWIM.pad,
        lanes,
        nodes,
        edges
      }
    }

    function SwimlaneView({ turn, loading, error, running, clock, details, actions, selectedNode, onSelect, onRetry, links, onOpenChild }) {
      const [zoom, setZoom] = React.useState(1)
      const [manual, setManual] = React.useState(false)
      const wrapRef = React.useRef(null)
      const layout = React.useMemo(() => layoutSwimlane(turn || { steps: [] }), [turn])

      const fitNow = () => {
        const element = wrapRef.current
        if (!element) return
        const available = element.clientWidth - 12
        if (available > 80 && layout.width > 0) setZoom(clampNumber(available / layout.width, 0.5, 1.15))
      }

      React.useEffect(() => {
        if (manual) return undefined
        const element = wrapRef.current
        if (!element) return undefined
        const apply = () => {
          const available = element.clientWidth - 12
          if (available > 80 && layout.width > 0) setZoom(clampNumber(available / layout.width, 0.5, 1.15))
        }
        apply()
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(apply)
          observer.observe(element)
        }
        return () => {
          if (observer) observer.disconnect()
        }
      }, [layout.width, manual])

      if (!turn) {
        return h(
          'div',
          { className: 'rl-scroll' },
          loading ? h(Skeleton, null) : error ? h(ErrorState, { error, onRetry }) : h(IdleState, null)
        )
      }

      const selected = selectedNode ? layout.nodes.find((node) => node.id === selectedNode) || null : null

      return h(
        'div',
        { className: 'rl-flow rl-swim' },
        h(
          'div',
          { className: 'rl-flow-toolbar' },
          h('span', { className: 'rl-flow-title' }, `回合 ${turn.turn} 泳道`),
          h('span', { className: 'rl-flow-meta' }, `${turn.steps.length} 步 · ${countStepTools(turn.steps)} 工具`),
          h('span', { className: 'rl-spacer' }),
          h(
            'button',
            {
              className: 'rl-mini',
              onClick: () => {
                setManual(true)
                setZoom((value) => clampNumber(value - 0.1, 0.4, 1.6))
              },
              title: '缩小'
            },
            '－'
          ),
          h(
            'button',
            {
              className: 'rl-mini' + (manual ? '' : ' rl-mini-on'),
              onClick: () => {
                setManual(false)
                fitNow()
              },
              title: '适应面板宽度'
            },
            `${Math.round(zoom * 100)}%`
          ),
          h(
            'button',
            {
              className: 'rl-mini',
              onClick: () => {
                setManual(true)
                setZoom((value) => clampNumber(value + 0.1, 0.4, 1.6))
              },
              title: '放大'
            },
            '＋'
          )
        ),
        h(
          'div',
          { className: 'rl-flow-scroll', ref: wrapRef },
          h(
            'div',
            { className: 'rl-flow-canvas', style: { width: layout.width * zoom, height: layout.height * zoom } },
            h(
              'div',
              { className: 'rl-flow-stage', style: { width: layout.width, height: layout.height, transform: `scale(${zoom})` } },
              layout.lanes.map((lane) =>
                h(
                  'div',
                  {
                    key: lane.id,
                    className: 'rl-swim-lane rl-swim-lane-' + lane.id,
                    style: { top: lane.y, height: lane.h }
                  },
                  h('span', { className: 'rl-swim-label' }, lane.label)
                )
              ),
              h(
                'svg',
                {
                  className: 'rl-flow-svg',
                  width: layout.width,
                  height: layout.height,
                  viewBox: `0 0 ${layout.width} ${layout.height}`,
                  'aria-hidden': 'true'
                },
                h(
                  'defs',
                  null,
                  h(
                    'marker',
                    {
                      id: 'rl-arrow',
                      viewBox: '0 0 8 8',
                      refX: 7,
                      refY: 4,
                      markerWidth: 6,
                      markerHeight: 6,
                      orient: 'auto-start-reverse'
                    },
                    h('path', { d: 'M 0 0 L 8 4 L 0 8 z', className: 'rl-flow-arrow' })
                  )
                ),
                layout.edges.map((edge) =>
                  h('path', {
                    key: edge.id,
                    d: edge.d,
                    className: `rl-flow-edge rl-flow-edge-${edge.kind}`,
                    markerEnd: 'url(#rl-arrow)'
                  })
                )
              ),
              layout.nodes.map((node) =>
                h(FlowNodeCard, {
                  key: node.id,
                  node,
                  selected: selected ? selected.id === node.id : false,
                  running,
                  clock,
                  onSelect
                })
              )
            )
          )
        ),
        selected
          ? h(FlowInspector, {
              turn,
              node: selected,
              running,
              clock,
              details,
              actions,
              links,
              onOpenChild,
              onClose: () => onSelect(null)
            })
          : null
      )
    }

    function bizChain(turn) {
      const nodes = []
      if (!turn) return nodes
      nodes.push({ kind: 'user', label: '用户提问', turn: turn.turn })
      for (const step of turn.steps || []) {
        nodes.push({
          kind: 'model',
          label: `模型 · ${step.step}`,
          step: step.step,
          error: Boolean(step.interrupted),
          meta:
            (step.usage && step.usage.outputTokens != null ? `出 ${fmtTokens(step.usage.outputTokens)}` : '') +
            (step.toolCalls && step.toolCalls.length ? `${step.toolCalls.length} 工具` : '')
        })
        for (const tool of step.toolCalls || []) {
          nodes.push({
            kind: 'tool',
            label: tool.name || '工具',
            step: step.step,
            callId: tool.callId,
            error: Boolean(tool.isError),
            meta: tool.durationMs != null ? fmtDuration(tool.durationMs) : ''
          })
        }
        if (step.text) {
          nodes.push({ kind: 'text', label: '输出', step: step.step, meta: `${step.text.length} 字` })
        }
      }
      nodes.push({ kind: 'end', label: '回合结束', turn: turn.turn, reason: turn.reason ? turn.reason.kind : null })
      return nodes
    }

    function BizFlowView({ snapshot, loading, error, running, clock, onJumpStep, onRetry, query, filter, links, onOpenChild }) {
      const listView = filterTurns(snapshot, query, filter)
      const turns = listView.turns
      const childLinks = Array.isArray(links) ? links : []
      if (loading && !snapshot) return h(Skeleton, null)
      if (error) return h(ErrorState, { error, onRetry })
      if (!snapshot) return h(IdleState, null)
      if (!turns.length) return h(EmptyState, { query, filter })
      return h(
        'div',
        { className: 'rl-bizflow rl-scroll' },
        h(
          'div',
          { className: 'rl-biz-intro' },
          '按回合汇总的业务动作流水线；点击「模型」节点在流程图中查看详情，点击「工具」节点直接定位到该工具。'
        ),
        turns.map((entry) => {
          const turn = entry.turn
          const steps = (turn.steps || []).length
          const tools = countStepTools(turn.steps)
          const duration = turnDuration(turn, running, clock)
          return h(
            'section',
            { key: turn.turn, className: 'rl-biz-turn' },
            h(
              'div',
              { className: 'rl-biz-head' },
              h('span', { className: 'rl-biz-turnno' }, `回合 ${turn.turn}`),
              h('span', { className: 'rl-biz-ask' }, turn.userText || '（无用户消息）'),
              h(
                'span',
                { className: 'rl-biz-meta' },
                `${steps} 步 · ${tools} 工具` +
                  (duration ? ` · ${fmtDuration(duration)}` : '') +
                  (turn.open && running ? ' · 进行中' : '')
              )
            ),
            h(
              'div',
              { className: 'rl-biz-chain' },
              bizChain(turn).map((node, index) =>
                h(
                  React.Fragment,
                  { key: `${node.kind}-${node.step || 0}-${index}` },
                  index > 0 ? h('span', { className: 'rl-biz-arrow' }, '›') : null,
                  h(
                    'button',
                    {
                      className:
                        'rl-biz-node rl-biz-' +
                        node.kind +
                        (node.error ? ' rl-biz-error' : '') +
                        (node.kind === 'tool' && childLinks.some((item) => item.callId === node.callId)
                          ? ' rl-biz-linked'
                          : ''),
                      onClick: () => {
                        const linked =
                          node.kind === 'tool' ? childLinks.find((item) => item.callId === node.callId) : null
                        if (linked && onOpenChild) {
                          onOpenChild({ id: linked.childId, label: '', mode: 'subagent' })
                          return
                        }
                        if (node.kind === 'user' || node.kind === 'end') {
                          onJumpStep(turn.turn, 1, null)
                        } else {
                          onJumpStep(turn.turn, node.step, node.callId || null)
                        }
                      },
                      title: node.meta || node.label
                    },
                    h('span', { className: 'rl-biz-node-label' }, node.label),
                    node.kind === 'tool' && childLinks.some((item) => item.callId === node.callId)
                      ? h('span', { className: 'rl-biz-node-meta' }, '↳ 子代理')
                      : node.meta
                        ? h('span', { className: 'rl-biz-node-meta' }, node.meta)
                        : null
                  )
                )
              )
            )
          )
        })
      )
    }

    /* ------------------------------------------------------------------ */
    /* 头部与指标                                                          */
    /* ------------------------------------------------------------------ */

    function Header({ snapshot, loading, error, onRefresh }) {
      const session = snapshot ? snapshot.session : null
      const model = snapshot ? snapshot.model : null
      const isRunning = Boolean(session && session.running)
      return h(
        'header',
        { className: 'rl-head' },
        h(
          'div',
          { className: 'rl-brand-row' },
          h('div', { className: 'rl-brand' }, h('span', { className: 'rl-brand-dot' }), '运行透视'),
          h(
            'div',
            { className: 'rl-head-actions' },
            error
              ? h('span', { className: 'rl-badge rl-badge-error' }, '● 读取失败')
              : h('span', { className: 'rl-badge ' + (isRunning ? 'rl-badge-run' : 'rl-badge-idle') }, isRunning ? '● 运行中' : '● 空闲'),
            h('button', { className: 'rl-icon-btn', onClick: onRefresh, title: '立即刷新', disabled: loading }, loading ? '…' : '↻')
          )
        ),
        h(
          'div',
          { className: 'rl-sub' },
          session ? h('span', { className: 'rl-sub-main' }, baseName(session.cwd) || '未知工作区') : h('span', null, '等待会话…'),
          session ? h('span', { className: 'rl-sep' }, '·') : null,
          session ? h('span', null, shortId(session.id)) : null,
          model ? h('span', { className: 'rl-sep' }, '·') : null,
          model ? h('span', null, modelLabel(model.provider, model.model)) : null,
          session && session.startedAt ? h('span', { className: 'rl-sep' }, '·') : null,
          session && session.startedAt ? h('span', null, '开始 ' + fmtClock(session.startedAt)) : null,
          session && session.lastEventTime ? h('span', { className: 'rl-sep' }, '·') : null,
          session && session.lastEventTime ? h('span', null, '最近 ' + fmtClock(session.lastEventTime)) : null
        )
      )
    }

    function Metrics({ snapshot }) {
      const totals = snapshot ? snapshot.totals : null
      if (!totals) return null
      const items = [
        ['回合', String(totals.turns)],
        ['步骤', String(totals.steps)],
        ['工具', String(totals.toolCalls)],
        ['输入', fmtTokens(totals.inputTokens)],
        ['输出', fmtTokens(totals.outputTokens)],
        ['缓存读', fmtTokens(totals.cacheReadTokens)],
        ['耗时', fmtDuration(totals.durationMs)],
        ['错误', String(totals.errors)]
      ]
      if (snapshot.model && snapshot.model.contextWindow) {
        items.push(['上下文', fmtTokens(snapshot.model.contextWindow)])
      }
      return h(
        'div',
        { className: 'rl-metrics' },
        items.map((item) =>
          h(
            'div',
            { key: item[0], className: 'rl-metric' },
            h('span', { className: 'rl-metric-label' }, item[0]),
            h('span', { className: 'rl-metric-value' }, item[1])
          )
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* 回合 / 步骤 / 工具                                                  */
    /* ------------------------------------------------------------------ */

    function TurnSection({ turn, steps, expanded, userExpanded, running, clock, details, toolOpen, reasonOpen, textOpen, copied, actions, links, onOpenChild }) {
      const toolCount = steps.reduce((count, step) => count + (step.toolCalls ? step.toolCalls.length : 0), 0)
      const reason = turn.reason
      return h(
        'section',
        { className: 'rl-turn', 'data-turn': turn.turn },
        h(
          'div',
          { className: 'rl-turn-head', onClick: () => actions.toggleTurn(turn.turn, expanded) },
          h('span', { className: 'rl-caret' }, expanded ? '▾' : '▸'),
          h('span', { className: 'rl-turn-no' }, `回合 ${turn.turn}`),
          reason ? h('span', { className: 'rl-tag ' + reasonTone(reason.kind) }, reasonLabel(reason.kind, reason.detail)) : null,
          turn.open ? h('span', { className: 'rl-tag rl-tag-run' }, '进行中') : null,
          h(
            'span',
            { className: 'rl-turn-meta' },
            `${steps.length} 步 · ${toolCount} 工具 · ${fmtDuration(turnDuration(turn, running, clock))}`,
            turn.usage && turn.usage.inputTokens ? ` · in ${fmtTokens(turn.usage.inputTokens)}` : ''
          )
        ),
        turn.userText
          ? h(
              'div',
              {
                className: 'rl-user' + (userExpanded ? ' rl-user-open' : ''),
                title: userExpanded ? '收起提问' : '点击展开完整提问',
                onClick: (event) => {
                  event.stopPropagation()
                  actions.toggleUser(turn.turn)
                }
              },
              turn.userText
            )
          : null,
        expanded
          ? h(
              'div',
              { className: 'rl-steps' },
              steps.length === 0
                ? h('div', { className: 'rl-empty-line' }, '这个回合没有可见步骤')
                : steps.map((step) =>
                    h(StepCard, {
                      key: step.id,
                      turn,
                      turnNo: turn.turn,
                      step,
                      running,
                      clock,
                      detailState: details[`${turn.turn}:${step.step}`],
                      toolOpen,
                      reasonOpen,
                      textOpen,
                      copied,
                      actions,
                      links,
                      onOpenChild
                    })
                  )
            )
          : null
      )
    }

    function StepCard({ turn, turnNo, step, running, clock, detailState, toolOpen, reasonOpen, textOpen, copied, actions, links, onOpenChild }) {
      const detail = detailState && detailState.data ? detailState.data : null
      const text = detail && detail.text ? detail.text : step.text
      const reasoning = detail && detail.reasoning ? detail.reasoning : step.reasoning
      const uid = `${turnNo}:${step.step}`
      const textIsOpen = Boolean(textOpen[uid])
      const reasonIsOpen = Boolean(reasonOpen[uid])
      const loadingDetail = detailState && detailState.loading
      const detailError = detailState && detailState.error
      const durationMs = step.open && running ? Math.max(0, clock - step.startedAt) : step.durationMs
      const tokenLine = step.usage
        ? `in ${fmtTokens(step.usage.inputTokens)} · out ${fmtTokens(step.usage.outputTokens)}` +
          (step.usage.cacheReadTokens ? ` · cache ${fmtTokens(step.usage.cacheReadTokens)}` : '')
        : ''
      const request = step.request || (detail ? detail.request : null)
      return h(
        'div',
        { className: 'rl-step' },
        h(
          'div',
          { className: 'rl-step-head' },
          h('span', { className: 'rl-step-badge' }, `步骤 ${step.step}`),
          h('span', { className: 'rl-step-model' }, request ? modelLabel(request.provider, request.model) : '模型调用'),
          step.interrupted ? h('span', { className: 'rl-tag rl-tag-warn' }, '被打断') : null,
          step.open ? h('span', { className: 'rl-tag rl-tag-run' }, '进行中') : null,
          h('span', { className: 'rl-step-duration' }, fmtDuration(durationMs)),
          h(
            'button',
            {
              className: 'rl-link rl-step-jump',
              onClick: (event) => {
                event.stopPropagation()
                actions.jumpToStep(turnNo, step.step, null)
              },
              title: '在流程图中查看这一步的详情'
            },
            '流程图'
          )
        ),
        h(
          'div',
          { className: 'rl-step-meta' },
          step.requests ? h('span', null, `请求 ${step.requests} 次`) : null,
          step.attempts ? h('span', null, `尝试 ${step.attempts}`) : null,
          step.firstTokenMs !== null && step.firstTokenMs !== undefined
            ? h('span', null, `首字 ${fmtDuration(step.firstTokenMs)}`)
            : null,
          step.streamMs ? h('span', null, `流式 ${fmtDuration(step.streamMs)}`) : null,
          tokenLine ? h('span', null, tokenLine) : null,
          request && request.tools ? h('span', null, `工具 ${request.tools}`) : null,
          request && request.reason ? h('span', null, requestReasonLabel(request.reason)) : null
        ),
        text || (step.textTruncated && detail === null)
          ? h(
              'div',
              { className: 'rl-output' },
              h(
                'div',
                { className: 'rl-block-head' },
                h('span', { className: 'rl-block-title' }, '模型输出'),
                loadingDetail ? h('span', { className: 'rl-block-hint' }, '加载中…') : null,
                h(
                  'span',
                  { className: 'rl-block-actions' },
                  step.textTruncated && !detail
                    ? h(
                        'button',
                        { className: 'rl-link', onClick: () => actions.loadDetail(turnNo, step.step) },
                        loadingDetail ? '加载中…' : '加载完整内容'
                      )
                    : null,
                  h(
                    'button',
                    {
                      className: 'rl-link',
                      onClick: () => actions.copy(text, `text-${uid}`)
                    },
                    copied === `text-${uid}` ? '已复制' : '复制'
                  ),
                  h(
                    'button',
                    { className: 'rl-link', onClick: () => actions.toggleText(turnNo, step.step) },
                    textIsOpen ? '收起' : '展开全文'
                  )
                )
              ),
              h('div', { className: 'rl-md' + (textIsOpen ? ' rl-md-full' : '') }, h(Markdown, { text }))
            )
          : null,
        detailError
          ? h('div', { className: 'rl-notice' }, `详情加载失败：${detailError}`)
          : null,
        reasoning
          ? h(
              'div',
              { className: 'rl-reason' },
              h(
                'button',
                { className: 'rl-subtoggle', onClick: () => actions.toggleReason(turnNo, step.step) },
                (reasonIsOpen ? '▾ ' : '▸ ') + `思考过程 · ${reasoning.length} 字`
              ),
              step.reasoningTruncated && !detail
                ? h(
                    'button',
                    { className: 'rl-link rl-link-inline', onClick: () => actions.loadDetail(turnNo, step.step) },
                    loadingDetail ? '加载中…' : '加载完整思考'
                  )
                : null,
              reasonIsOpen
                ? h(SmoothText, {
                    text: reasoning,
                    streaming: Boolean(step.open && running),
                    className: 'rl-reason-pre rl-smooth'
                  })
                : null
            )
          : null,
        step.toolCalls && step.toolCalls.length
          ? h(
              'div',
              { className: 'rl-tools' },
              step.toolCalls.map((tool, index) => {
                const toolKey = tool.callId || `tool-${index}`
                const toolUid = `${uid}:${toolKey}`
                return h(ToolRow, {
                  key: toolUid,
                  tool,
                  toolKey,
                  toolUid,
                  open: Boolean(toolOpen[toolUid]),
                  detailState,
                  copied,
                  actions,
                  turnNo,
                  stepNo: step.step,
                  running,
                  clock,
                  links,
                  onOpenChild
                })
              })
            )
          : null,
        h(DivergencePanel, { turn, step, detail, actions })
      )
    }

    function ToolRow({ tool, toolKey, toolUid, open, detailState, copied, actions, turnNo, stepNo, running, clock, links, onOpenChild }) {
      const detail = detailState && detailState.data ? detailState.data : null
      const detailTool = detail && Array.isArray(detail.tools) ? detail.tools.find((item) => item.callId === toolKey) : null
      const childLink = Array.isArray(links) ? links.find((item) => item && item.callId === toolKey) || null : null
      const args = detailTool ? detailTool.arguments : tool.arguments
      const resultText = detailTool ? detailTool.resultText : tool.resultText
      const meta = detailTool ? detailTool.meta : tool.meta
      const error = tool.error
      const loadingDetail = detailState && detailState.loading
      const missingDetail = (tool.argumentsTruncated || tool.resultTruncated) && !detailTool
      const statusLabel = tool.open ? '进行中' : tool.isError ? '错误' : '完成'
      const statusClass = tool.open ? 'rl-tag-run' : tool.isError ? 'rl-tag-error' : 'rl-tag-ok'
      const durationMs = tool.open && running ? Math.max(0, clock - tool.startedAt) : tool.durationMs
      return h(
        'div',
        { className: 'rl-tool' },
        h(
          'div',
          {
            className: 'rl-tool-head',
            onClick: () => actions.toggleTool(turnNo, stepNo, toolKey, missingDetail)
          },
          h('span', { className: 'rl-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'rl-tool-name' }, tool.name || '工具'),
          h('span', { className: 'rl-tag ' + statusClass }, statusLabel),
          h('span', { className: 'rl-tool-duration' }, fmtDuration(durationMs))
        ),
        open
          ? h(
              'div',
              { className: 'rl-tool-body' },
              childLink
                ? h(
                    'button',
                    {
                      className: 'rl-mini rl-open-child',
                      onClick: () => onOpenChild({ id: childLink.childId, label: '', mode: 'subagent' })
                    },
                    '打开子代理运行图'
                  )
                : null,
              loadingDetail ? h('div', { className: 'rl-block-hint' }, '正在加载完整内容…') : null,
              args
                ? h(
                    'div',
                    { className: 'rl-field' },
                    h(
                      'div',
                      { className: 'rl-field-head' },
                      h('span', null, '参数'),
                      h(
                        'button',
                        { className: 'rl-link', onClick: () => actions.copy(args, `args-${toolUid}`) },
                        copied === `args-${toolUid}` ? '已复制' : '复制'
                      )
                    ),
                    h('pre', { className: 'rl-pre' }, args)
                  )
                : null,
              resultText
                ? h(
                    'div',
                    { className: 'rl-field' },
                    h(
                      'div',
                      { className: 'rl-field-head' },
                      h('span', null, '返回'),
                      h(
                        'button',
                        { className: 'rl-link', onClick: () => actions.copy(resultText, `result-${toolUid}`) },
                        copied === `result-${toolUid}` ? '已复制' : '复制'
                      )
                    ),
                    h('pre', { className: 'rl-pre' }, resultText)
                  )
                : null,
              error
                ? h(
                    'div',
                    { className: 'rl-field' },
                    h('div', { className: 'rl-field-head rl-field-error' }, '错误'),
                    h(
                      'pre',
                      { className: 'rl-pre rl-pre-error' },
                      [error.name, error.code, error.reason].filter((item) => typeof item === 'string' && item).join(' · ') || '工具调用失败'
                    )
                  )
                : null,
              meta
                ? h(
                    'div',
                    { className: 'rl-field' },
                    h('div', { className: 'rl-field-head' }, '附加信息'),
                    h('pre', { className: 'rl-pre' }, meta)
                  )
                : null,
              missingDetail && !loadingDetail
                ? h(
                    'button',
                    { className: 'rl-link', onClick: () => actions.loadDetail(turnNo, stepNo) },
                    '加载完整参数与返回'
                  )
                : null
            )
          : null
      )
    }

    /* ------------------------------------------------------------------ */
    /* 状态组件                                                            */
    /* ------------------------------------------------------------------ */

    function IdleState() {
      return h(
        'div',
        { className: 'rl-empty' },
        h('div', { className: 'rl-empty-title' }, '跟随当前会话'),
        h('div', null, '在左侧开始或选择一个会话后，这里会显示它的运行过程：'),
        h('div', { className: 'rl-empty-list' }, '回合 → 步骤 → 模型调用 / 工具调用，以及耗时、token 与错误。'),
        h('div', { className: 'rl-empty-hint' }, '提示：面板会自动跟随你正在查看的会话。')
      )
    }

    function ErrorState({ error, onRetry }) {
      return h(
        'div',
        { className: 'rl-empty' },
        h('div', { className: 'rl-empty-title rl-error-title' }, '读取运行记录失败'),
        h('div', { className: 'rl-error-text' }, error),
        h('button', { className: 'rl-retry', onClick: onRetry }, '重试')
      )
    }

    function EmptyState({ query, filter }) {
      const filtered = Boolean(query.trim()) || filter !== 'all'
      return h(
        'div',
        { className: 'rl-empty' },
        h('div', { className: 'rl-empty-title' }, filtered ? '没有匹配的内容' : '这个会话还没有运行记录'),
        h(
          'div',
          null,
          filtered
            ? '试试清空搜索、切换到「全部」，或换一个关键词。'
            : '在左侧发送一条消息，运行步骤会自动出现在这里。'
        )
      )
    }

    function Skeleton() {
      return h(
        'div',
        { className: 'rl-skeleton' },
        h('div', { className: 'rl-skeleton-bar' }),
        h('div', { className: 'rl-skeleton-bar' }),
        h('div', { className: 'rl-skeleton-bar rl-skeleton-short' })
      )
    }

    /* ------------------------------------------------------------------ */
    /* 文本渲染（轻量 Markdown，避免引入依赖）                              */
    /* ------------------------------------------------------------------ */

    const Markdown = React.memo(function Markdown({ text }) {
      return h(React.Fragment, null, renderMarkdown(text))
    })

    function renderInline(text, keyPrefix) {
      const nodes = []
      const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g
      let lastIndex = 0
      let match
      let index = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
        const token = match[0]
        index += 1
        if (token.charAt(0) === '`') {
          nodes.push(h('code', { key: `${keyPrefix}-c${index}`, className: 'rl-inline-code' }, token.slice(1, -1)))
        } else {
          nodes.push(h('strong', { key: `${keyPrefix}-b${index}` }, token.slice(2, -2)))
        }
        lastIndex = match.index + token.length
      }
      if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
      return nodes
    }

    function isSpecialLine(line) {
      return (
        /^\s*$/.test(line) ||
        /^\s*```/.test(line) ||
        /^#{1,4}\s+/.test(line) ||
        /^\s*([-*+]|\d+\.)\s+/.test(line) ||
        /^\s*>\s?/.test(line)
      )
    }

    function renderMarkdown(text) {
      const value = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : ''
      if (!value) return []
      const lines = value.split('\n')
      const nodes = []
      let index = 0
      let key = 0
      while (index < lines.length) {
        const line = lines[index]
        if (/^\s*```/.test(line)) {
          const code = []
          index += 1
          while (index < lines.length && !/^\s*```/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          nodes.push(h('pre', { key: `rl-pre-${key++}`, className: 'rl-code' }, code.join('\n')))
          continue
        }
        if (/^\s*$/.test(line)) {
          index += 1
          continue
        }
        if (/^#{1,4}\s+/.test(line)) {
          const title = line.replace(/^#{1,4}\s+/, '')
          nodes.push(h('div', { key: `rl-h-${key++}`, className: 'rl-h' }, renderInline(title, `h-${key}`)))
          index += 1
          continue
        }
        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
          const ordered = /^\s*\d+\.\s+/.test(line)
          const items = []
          while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index])) {
            const content = lines[index].replace(/^\s*([-*+]|\d+\.)\s+/, '')
            items.push(h('li', { key: `rl-li-${key++}` }, renderInline(content, `li-${key}`)))
            index += 1
          }
          nodes.push(h(ordered ? 'ol' : 'ul', { key: `rl-list-${key++}`, className: 'rl-list' }, items))
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const quotes = []
          while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
            quotes.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          nodes.push(h('blockquote', { key: `rl-quote-${key++}`, className: 'rl-quote' }, renderInline(quotes.join('\n'), `q-${key}`)))
          continue
        }
        const paragraph = [line]
        index += 1
        while (index < lines.length && !isSpecialLine(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        nodes.push(h('p', { key: `rl-p-${key++}`, className: 'rl-p' }, renderInline(paragraph.join('\n'), `p-${key}`)))
      }
      return nodes
    }

    /* ------------------------------------------------------------------ */
    /* 过滤与格式化                                                        */
    /* ------------------------------------------------------------------ */

    function includesQuery(value, query) {
      return typeof value === 'string' && value.toLowerCase().includes(query)
    }

    function stepMatchesFilter(step, filter, query) {
      if (filter === 'model' && !step.text && !step.reasoning) return false
      if (filter === 'tool' && (!step.toolCalls || step.toolCalls.length === 0)) return false
      if (filter === 'error' && !(step.toolCalls || []).some((tool) => tool.isError)) return false
      if (!query) return true
      if (includesQuery(step.text, query) || includesQuery(step.reasoning, query)) return true
      for (const tool of step.toolCalls || []) {
        if (includesQuery(tool.name, query) || includesQuery(tool.arguments, query) || includesQuery(tool.resultText, query)) {
          return true
        }
        if (tool.error && (includesQuery(tool.error.name, query) || includesQuery(tool.error.code, query) || includesQuery(tool.error.reason, query))) {
          return true
        }
      }
      return false
    }

    function filterTurns(snapshot, query, filter) {
      if (!snapshot || !Array.isArray(snapshot.turns)) return { turns: [], total: 0, matched: false }
      const needle = String(query || '').trim().toLowerCase()
      if (!needle && filter === 'all') {
        const turns = snapshot.turns.map((turn) => ({ turn, steps: turn.steps }))
        let total = 0
        for (const turn of snapshot.turns) total += turn.steps.length
        return { turns, total, matched: false }
      }
      const turns = []
      let total = 0
      for (const turn of snapshot.turns) {
        const userHit = needle ? includesQuery(turn.userText, needle) : false
        const steps = turn.steps.filter((step) => stepMatchesFilter(step, filter, needle))
        const turnLevelError = filter === 'error' && turn.reason && turn.reason.kind === 'error'
        if (steps.length === 0 && !userHit && !turnLevelError) continue
        const shown = steps.length > 0 ? steps : turnLevelError ? turn.steps : []
        total += shown.length
        turns.push({ turn, steps: shown })
      }
      return { turns, total, matched: true }
    }

    function turnDuration(turn, running, clock) {
      if (turn.open && running) return Math.max(0, clock - turn.startedAt)
      return turn.durationMs || 0
    }

    function baseName(path) {
      if (typeof path !== 'string' || !path) return ''
      const parts = path.split(/[\\/]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : path
    }

    function shortId(id) {
      if (typeof id !== 'string' || !id) return ''
      return id.length <= 14 ? id : id.slice(0, 8) + '…' + id.slice(-4)
    }

    function modelLabel(provider, model) {
      if (model && provider && provider !== model) return `${model} · ${provider}`
      if (model) return model
      if (provider) return provider
      return '模型未知'
    }

    function fmtTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
      if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1) + 'M'
      if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 'k'
      return String(Math.round(value))
    }

    function fmtDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return Math.round(ms) + 'ms'
      if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's'
      const minutes = Math.floor(ms / 60000)
      const seconds = Math.round((ms % 60000) / 1000)
      return `${minutes}m${seconds ? ' ' + seconds + 's' : ''}`
    }

    function fmtClock(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
      try {
        return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
      } catch {
        return ''
      }
    }

    function reasonLabel(kind, detail) {
      const base =
        {
          completed: '完成',
          blocked: '被阻止',
          'max-tokens': '达到 token 上限',
          interrupted: '被打断',
          forked: '已分叉',
          error: '出错',
          aborted: '已中止'
        }[kind] || kind || '结束'
      return detail ? `${base}：${detail}` : base
    }

    function reasonTone(kind) {
      if (kind === 'error') return 'rl-tag-error'
      if (kind === 'aborted' || kind === 'blocked' || kind === 'max-tokens' || kind === 'interrupted') return 'rl-tag-warn'
      return 'rl-tag-ok'
    }

    function requestReasonLabel(reason) {
      if (reason === 'initial') return '首次请求'
      if (reason === 'resume') return '继续请求'
      if (reason === 'change') return '配置变更'
      if (reason === 'series') return '连续请求'
      return ''
    }

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    const STYLES = `
.rl-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.5;
  container-type: inline-size;
}
.rl-head {
  flex: none;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.rl-brand-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rl-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.2px;
}
.rl-brand-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 6px var(--dsw-alias-brand-primary);
}
.rl-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.rl-badge {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.rl-badge-run { color: var(--dsw-alias-state-success-primary); }
.rl-badge-idle { color: var(--dsw-alias-state-idle-primary); }
.rl-badge-error { color: var(--dsw-alias-state-error-primary); }
.rl-icon-btn {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}
.rl-icon-btn:hover { color: var(--dsw-alias-label-primary); }
.rl-icon-btn:disabled { opacity: 0.6; cursor: default; }
.rl-sub {
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.rl-sub-main { color: var(--dsw-alias-label-primary); }
.rl-sep { opacity: 0.5; }
.rl-metrics {
  flex: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(70px, 1fr));
  gap: 6px;
  padding: 8px 12px;
}
.rl-metric {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
}
.rl-metric-label {
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.rl-metric-value {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rl-toolbar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 12px 8px;
}
.rl-search-row { position: relative; }
.rl-search {
  width: 100%;
  box-sizing: border-box;
  height: 28px;
  padding: 0 26px 0 9px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  outline: none;
}
.rl-search:focus { border-color: var(--dsw-alias-brand-primary); }
.rl-search::placeholder { color: var(--dsw-alias-label-secondary); }
.rl-clear {
  position: absolute;
  right: 5px;
  top: 3px;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.rl-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.rl-chip {
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  cursor: pointer;
  line-height: 1.6;
}
.rl-chip:hover { color: var(--dsw-alias-label-primary); }
.rl-chip-active {
  color: var(--dsw-alias-bg-base);
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.rl-spacer { flex: 1; }
.rl-count {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.rl-mini {
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  cursor: pointer;
  line-height: 1.6;
}
.rl-mini:hover { border-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.rl-mini-on { color: var(--dsw-alias-state-success-primary); }
.rl-jump-select {
  padding: 2px 4px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  max-width: 96px;
}
.rl-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 12px 14px;
  overscroll-behavior: contain;
}
.rl-turn {
  margin-bottom: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.rl-turn-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  cursor: pointer;
  user-select: none;
}
.rl-turn-head:hover { background: var(--dsw-alias-bg-layer-2); }
.rl-caret {
  width: 12px;
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
}
.rl-turn-no { font-weight: 600; font-size: 12px; }
.rl-turn-meta {
  margin-left: auto;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.rl-user {
  margin: 0 9px 7px;
  padding: 6px 8px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: pointer;
}
.rl-user-open { display: block; -webkit-line-clamp: unset; }
.rl-steps {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 0 9px 9px;
}
.rl-step {
  border-top: 1px dashed var(--dsw-alias-border-l1);
  padding-top: 6px;
}
.rl-step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.rl-step-badge { color: var(--dsw-alias-brand-primary); font-size: 11px; font-weight: 600; }
.rl-step-model { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.rl-step-duration { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.rl-step-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 8px;
  margin: 2px 0 4px;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}
.rl-tag {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  font-size: 10px;
  line-height: 1.6;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary);
}
.rl-tag-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.rl-tag-run { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.rl-tag-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.rl-tag-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.rl-output {
  margin: 3px 0 5px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  overflow: hidden;
}
.rl-block-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: var(--dsw-alias-bg-layer-2);
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}
.rl-block-title { color: var(--dsw-alias-label-secondary); }
.rl-block-hint { color: var(--dsw-alias-label-secondary); }
.rl-block-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.rl-link {
  border: none;
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font-size: 10px;
  padding: 0;
  cursor: pointer;
  line-height: 1.6;
}
.rl-link:hover { text-decoration: underline; }
.rl-link-inline { margin-left: 6px; }
.rl-md {
  padding: 6px 9px;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}
.rl-md-full { max-height: none; }
.rl-p { margin: 0 0 5px; }
.rl-p:last-child { margin-bottom: 0; }
.rl-h { margin: 6px 0 3px; font-weight: 600; }
.rl-list { margin: 2px 0 6px; padding-left: 18px; }
.rl-list li { margin: 1px 0; }
.rl-quote {
  margin: 4px 0;
  padding: 3px 9px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.rl-code {
  margin: 4px 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  overflow: auto;
  font-size: 11px;
  white-space: pre;
}
.rl-inline-code {
  padding: 0 3px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
}
.rl-reason { margin: 3px 0 5px; }
.rl-subtoggle {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  padding: 0;
  cursor: pointer;
}
.rl-subtoggle:hover { color: var(--dsw-alias-label-primary); }
.rl-reason-pre {
  margin: 3px 0 0;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.rl-tools { margin: 3px 0; display: flex; flex-direction: column; gap: 4px; }
.rl-tool {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-base);
  overflow: hidden;
}
.rl-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  user-select: none;
}
.rl-tool-head:hover { background: var(--dsw-alias-bg-layer-2); }
.rl-tool-name { font-size: 11px; font-weight: 600; word-break: break-all; }
.rl-tool-duration { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.rl-tool-body { padding: 5px 8px 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.rl-field { margin-bottom: 6px; }
.rl-field:last-child { margin-bottom: 0; }
.rl-field-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 2px;
}
.rl-field-head .rl-link { margin-left: auto; }
.rl-field-error { color: var(--dsw-alias-state-error-primary); }
.rl-pre {
  margin: 0;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.rl-pre-error { color: var(--dsw-alias-state-error-primary); }
.rl-notice {
  margin: 3px 0;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
  font-size: 10px;
}
.rl-empty {
  padding: 28px 16px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  line-height: 1.8;
  font-size: 12px;
}
.rl-empty-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  margin-bottom: 4px;
}
.rl-empty-list { color: var(--dsw-alias-label-primary); }
.rl-empty-hint { margin-top: 8px; font-size: 11px; }
.rl-error-title { color: var(--dsw-alias-state-error-primary); }
.rl-error-text { font-size: 11px; word-break: break-word; }
.rl-retry {
  margin-top: 10px;
  padding: 4px 14px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-brand-primary);
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  cursor: pointer;
  font-size: 11px;
}
.rl-skeleton { padding: 18px 12px; display: flex; flex-direction: column; gap: 8px; }
.rl-skeleton-bar {
  height: 28px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1);
  animation: rl-pulse 1.2s ease-in-out infinite;
}
.rl-skeleton-short { width: 60%; }
.rl-jump {
  position: absolute;
  right: 18px;
  bottom: 16px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-brand-primary);
  font-size: 11px;
  cursor: pointer;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.25);
}
@keyframes rl-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 0.95; }
}
.rl-mode-row { padding-bottom: 0; }
.rl-mode-flow .rl-list-only { display: none; }
.rl-flow { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.rl-flow-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: 0 0 auto;
}
.rl-flow-title { font-size: 11px; font-weight: 600; }
.rl-flow-meta { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.rl-flow-scroll { position: relative; flex: 1; min-height: 0; overflow: auto; padding: 6px 8px 12px; }
.rl-flow-canvas { position: relative; margin: 0 auto; }
.rl-flow-stage { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.rl-flow-svg { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.rl-flow-edge { fill: none; stroke: var(--dsw-alias-border-l2); stroke-width: 1.4; }
.rl-flow-edge-error { stroke: var(--dsw-alias-state-error-primary); }
.rl-flow-arrow { fill: var(--dsw-alias-border-l2); }
.rl-node {
  position: absolute;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  text-align: left;
  padding: 7px 10px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  overflow: hidden;
  font: inherit;
}
.rl-node:hover { border-color: var(--dsw-alias-brand-primary); }
.rl-node-selected { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.rl-node-user { background: var(--dsw-alias-bg-layer-2); }
.rl-node-end { background: var(--dsw-alias-bg-layer-2); }
.rl-node-kicker {
  font-size: 9px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-secondary);
}
.rl-node-title {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rl-node-text {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rl-node-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.rl-node-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  margin-left: auto;
  flex: 0 0 auto;
}
.rl-dot-busy { background: var(--dsw-alias-state-warn-primary); animation: rl-pulse 1s ease-in-out infinite; }
.rl-dot-warn { background: var(--dsw-alias-state-warn-primary); }
.rl-node-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 1px 8px;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}
.rl-node-tool { background: var(--dsw-alias-bg-base); }
.rl-node-tool-error { border-color: var(--dsw-alias-state-error-primary); }
.rl-node-tool-busy { border-color: var(--dsw-alias-state-warn-primary); }
.rl-node-tool-icon { font-size: 10px; flex: 0 0 auto; }
.rl-node-tool-name {
  font-size: 11px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rl-node-agent { background: var(--dsw-alias-bg-layer-2); }
.rl-node-agent-open { border-color: var(--dsw-alias-brand-primary); }
.rl-node-agent-caret { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 10px; flex: 0 0 auto; }
.rl-node-hint { font-size: 9px; color: var(--dsw-alias-label-secondary); }
.rl-node-agent-merged { margin-left: auto; font-size: 9px; color: var(--dsw-alias-brand-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); border-radius: 999px; padding: 0 6px; flex: 0 0 auto; }
.rl-insp-merged { font-size: 10px; color: var(--dsw-alias-brand-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); border-radius: 999px; padding: 1px 8px; }
.rl-node-group {
  cursor: default;
  background: var(--dsw-alias-bg-layer-2);
  border-style: dashed;
}
.rl-node-group:hover { border-color: var(--dsw-alias-border-l1); }
.rl-flow-edge-agent { stroke: var(--dsw-alias-brand-primary); stroke-dasharray: 4 3; }
.rl-inspector {
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  max-height: 46%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 0 0 auto;
}
.rl-insp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: 0 0 auto;
}
.rl-insp-title { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl-insp-body { overflow: auto; padding: 8px 12px 12px; min-height: 0; }
.rl-insp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 8px;
}
.rl-insp-section { margin-bottom: 8px; }
.rl-insp-section:last-child { margin-bottom: 0; }
.rl-insp-label { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-bottom: 3px; }
.rl-md-body { max-height: 300px; overflow: auto; }
.rl-mini-loading { opacity: 0.6; }
.rl-toolbar-label { font-size: 10px; color: var(--dsw-alias-label-secondary); padding: 0 2px; }
.rl-preset-row { gap: 6px; }
.rl-preset-select {
  max-width: 160px;
  font: inherit;
  font-size: 11px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  padding: 2px 4px;
}
.rl-preset-input {
  width: 120px;
  font: inherit;
  font-size: 11px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  padding: 2px 6px;
}
.rl-preset-input:focus { outline: 1px solid var(--dsw-alias-brand-primary); }
.rl-smooth-live::after {
  content: '▍';
  color: var(--dsw-alias-brand-primary);
  animation: rl-caret 0.9s steps(2, start) infinite;
}
@keyframes rl-caret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
.rl-divergence {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 6px 9px;
  margin-bottom: 8px;
  background: var(--dsw-alias-bg-base);
}
.rl-divergence-item { font-size: 11px; line-height: 1.5; margin: 2px 0; }
.rl-divergence-warn { color: var(--dsw-alias-state-warn-primary); }
.rl-divergence-info { color: var(--dsw-alias-label-secondary); }
.rl-divergence-note { font-size: 9px; color: var(--dsw-alias-label-secondary); margin-top: 3px; opacity: 0.8; }
.rl-kw-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 4px; }
.rl-kw-label { font-size: 9px; color: var(--dsw-alias-label-secondary); margin-right: 2px; }
.rl-kw { font-size: 10px; padding: 0 5px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); line-height: 16px; }
.rl-kw-hit { color: var(--dsw-alias-state-success-primary); }
.rl-kw-miss { color: var(--dsw-alias-state-warn-primary); text-decoration: line-through; opacity: 0.75; }
.rl-compare { margin-top: 6px; }
.rl-compare-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; margin-top: 5px; }
.rl-compare-col { border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 4px 6px; background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.rl-compare-head { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--dsw-alias-label-secondary); margin-bottom: 3px; }
.rl-compare-body { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 10px; line-height: 1.5; color: var(--dsw-alias-label-primary); max-height: 220px; overflow: auto; }
.rl-step-jump { margin-left: 6px; flex: 0 0 auto; font-size: 10px; }
.rl-reason-pre.rl-smooth { white-space: pre-wrap; }
@container (max-width: 360px) {
  .rl-compare-grid { grid-template-columns: minmax(0, 1fr); }
}
.rl-subagents {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px 12px 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  flex: 0 0 auto;
}
.rl-subagent-trail { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
.rl-trail-link {
  font: inherit;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 1px 4px;
  cursor: pointer;
}
.rl-trail-link:hover { color: var(--dsw-alias-brand-primary); }
.rl-trail-current { color: var(--dsw-alias-label-primary); font-weight: 600; }
.rl-trail-sep { font-size: 10px; color: var(--dsw-alias-label-secondary); padding: 0 1px; }
.rl-subagent-error { font-size: 10px; color: var(--dsw-alias-state-error-primary); }
.rl-subagent-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.rl-subagent-label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.rl-subagent-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: inherit;
  font-size: 10px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  padding: 2px 8px;
  cursor: pointer;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rl-subagent-chip:hover { border-color: var(--dsw-alias-brand-primary); }
.rl-subagent-running { border-color: var(--dsw-alias-state-warn-primary); }
.rl-subagent-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  flex: 0 0 auto;
}
.rl-subagent-meta { font-size: 9px; color: var(--dsw-alias-label-secondary); }
.rl-subagent-nested { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.rl-chat { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.rl-chat-turn {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-bottom: 1px dashed var(--dsw-alias-border-l1);
  padding-bottom: 10px;
}
.rl-chat-turn:last-child { border-bottom: none; padding-bottom: 0; }
.rl-chat-turn-live .rl-chat-turn-head { position: sticky; top: 0; }
.rl-chat-turn-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
  background: var(--dsw-alias-bg-base);
  padding: 2px 0;
  z-index: 1;
}
.rl-bubble { display: flex; flex-direction: column; gap: 4px; }
.rl-bubble-user { align-items: flex-end; }
.rl-bubble-role {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}
.rl-bubble-user .rl-bubble-role { justify-content: flex-end; }
.rl-bubble-jump {
  font: inherit;
  font-size: 9px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  padding: 1px 7px;
  cursor: pointer;
}
.rl-bubble-jump:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.rl-bubble-body {
  max-width: 88%;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.rl-bubble-assistant .rl-bubble-body { max-width: 100%; }
.rl-bubble-assistant .rl-chat-text { font-size: 12px; line-height: 1.55; }
.rl-bubble-live .rl-chat-text { opacity: 0.92; }
.rl-thinking { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.rl-thinking-toggle {
  font: inherit;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  border: none;
  padding: 1px 0;
  cursor: pointer;
}
.rl-thinking-toggle:hover { color: var(--dsw-alias-brand-primary); }
.rl-thinking-body {
  margin-top: 3px;
  padding: 6px 9px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  border-radius: 0 6px 6px 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.rl-thinking-live .rl-thinking-body { color: var(--dsw-alias-label-primary); }
.rl-typing { font-size: 11px; color: var(--dsw-alias-label-secondary); animation: rl-pulse 1.2s ease-in-out infinite; }
.rl-chat-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.rl-chat-tool {
  font: inherit;
  font-size: 10px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  padding: 1px 8px;
  cursor: pointer;
}
.rl-chat-tool:hover { border-color: var(--dsw-alias-brand-primary); }
.rl-chat-tool-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.rl-swim-lane {
  position: absolute;
  left: 0;
  right: 0;
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
}
.rl-swim-lane-model { background: var(--dsw-alias-bg-layer-1); }
.rl-swim-lane-tool { background: var(--dsw-alias-bg-base); }
.rl-swim-label {
  position: absolute;
  left: 8px;
  top: 4px;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  letter-spacing: 0.04em;
}
.rl-swim .rl-node { z-index: 1; }
.rl-open-child { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.rl-bizflow { padding: 10px 12px 24px; }
.rl-biz-intro { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; line-height: 1.5; }
.rl-biz-turn {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 7px 9px;
  margin-bottom: 8px;
}
.rl-biz-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin-bottom: 6px; }
.rl-biz-turnno { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-primary); flex: 0 0 auto; }
.rl-biz-ask {
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 120px;
  min-width: 0;
  max-width: 100%;
}
.rl-biz-meta { font-size: 9px; color: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.rl-biz-chain { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
.rl-biz-node {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 10px;
  padding: 2px 6px;
  cursor: pointer;
  max-width: 100%;
}
.rl-biz-node:hover { border-color: var(--dsw-alias-brand-primary); }
.rl-biz-node-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl-biz-node-meta { font-size: 9px; color: var(--dsw-alias-label-secondary); }
.rl-biz-user { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.rl-biz-tool { background: var(--dsw-alias-bg-base); }
.rl-biz-text { border-style: dashed; }
.rl-biz-end { color: var(--dsw-alias-label-secondary); }
.rl-biz-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.rl-biz-linked { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.rl-root:focus { outline: none; }
.rl-biz-live { box-shadow: 0 0 0 1px var(--dsw-alias-state-idle-primary) inset; }
.rl-biz-arrow { color: var(--dsw-alias-label-secondary); font-size: 11px; opacity: 0.7; }
@container (max-width: 360px) {
  .rl-metrics { grid-template-columns: repeat(2, 1fr); }
  .rl-turn-meta { width: 100%; margin-left: 12px; }
  .rl-flow-jump { max-width: 96px; }
}

/* —— 视觉打磨：更安静的底色、更清晰的层级与状态 —— */
.rl-root {
  background:
    radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent), transparent 58%),
    radial-gradient(90% 70% at 0% 100%, color-mix(in srgb, var(--dsw-alias-state-idle-primary) 7%, transparent), transparent 62%),
    var(--dsw-alias-bg-base);
}
.rl-head { position: sticky; top: 0; z-index: 6; padding-top: 4px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 84%, transparent); backdrop-filter: blur(10px); }
.rl-metric { position: relative; overflow: hidden; background: linear-gradient(160deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); transition: border-color .16s ease, transform .16s ease; }
.rl-metric:hover { border-color: var(--dsw-alias-border-l2); transform: translateY(-1px); }
.rl-metric::after { content: ''; position: absolute; inset: 0 0 auto 0; height: 2px; background: linear-gradient(90deg, var(--dsw-alias-brand-primary), transparent 78%); opacity: .55; }
.rl-metric-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 48%, transparent); }
.rl-chip, .rl-mini { transition: background .15s ease, border-color .15s ease, transform .12s ease; }
.rl-chip:hover, .rl-mini:hover { border-color: var(--dsw-alias-brand-primary); }
.rl-chip-active { box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 60%, transparent) inset; }
.rl-flow-toolbar { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 88%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.rl-flow-jump { height: 24px; max-width: 118px; padding: 0 6px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 11px; }
.rl-flow-jump:hover { border-color: var(--dsw-alias-brand-primary); }
.rl-flow-canvas { background-image: radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--dsw-alias-label-secondary) 22%, transparent) 1px, transparent 0); background-size: 22px 22px; border-radius: 12px; }
.rl-flow-scroll { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2) transparent; }
.rl-flow-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.rl-flow-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dsw-alias-border-l2) 80%, transparent); border-radius: 8px; }
.rl-node {
  transition: transform .14s ease, box-shadow .14s ease, border-color .14s ease;
  animation: rl-node-in .18s ease-out both;
}
.rl-node:hover { transform: translateY(-1px); border-color: var(--dsw-alias-border-l2); box-shadow: 0 8px 20px rgba(0, 0, 0, .12); }
.rl-node-selected { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 34%, transparent); }
.rl-node-agent { background: linear-gradient(150deg, color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, var(--dsw-alias-bg-layer-2)), var(--dsw-alias-bg-layer-1)); }
.rl-node-group { cursor: pointer; }
.rl-node-group:hover { border-color: var(--dsw-alias-brand-primary); }
.rl-flow-edge { stroke-linecap: round; }
.rl-flow-edge-agent { filter: drop-shadow(0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent)); }
.rl-inspector {
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, transparent);
  backdrop-filter: blur(12px);
  box-shadow: 0 -10px 28px rgba(0, 0, 0, .08);
}
.rl-insp-section { border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 8px; }
.rl-empty, .rl-empty-hint { opacity: .82; }
.rl-root .rl-search:focus, .rl-root .rl-preset-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); }
@keyframes rl-node-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@keyframes rl-busy-pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
.rl-node-busy { animation: rl-busy-pulse 2.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .rl-node, .rl-node-busy { animation: none; transition: none; }
}
`

    /* ------------------------------------------------------------------ */
    /* 注册                                                                */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(() =>
        ctx.desktopWorkbenches.register(
          {
            title: '运行透视',
            description:
              '跟随当前会话，用会话 / 时间线 / 全景图三种视图查看整段运行：全景图把主会话所有回合、工具调用与子代理画在同一张图里，子代理（含嵌套层级）默认全部展开并入同一张图，支持完整内容按需加载、丝滑思考与思路偏离对照。',
            layout: { businessSide: 'right', businessWidth: 0.44 }
          },
          BusinessPanel
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
