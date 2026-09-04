/**
 * ProactiveAI 手机端 Web UI（公网中继模式）。
 * 数据：/api/status / /api/history / POST /api/send（请求-响应拿真实 messageId）+ SSE 实时流。
 * 显示的唯一事实来源是 SSE 推送（发送侧不做 optimistic 双写，天然无重复）。
 * 样式对齐宿主：assistant 无卡片直出 markdown、时间戳小字、--app-* token 亮暗跟随系统。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, SendHorizontal } from 'lucide-react'
import type { ChatMessage, Conversation } from './types/domain'
import type { AgentStreamPushV1 } from './types/stream'
import type { WidgetNode } from './types/ui'
import { MarkdownView } from './components/markdown/MarkdownView'
import { formatDate } from './utils/helpers'
import { WidgetRenderer } from './widget'
import { Toaster } from './components/ui/toaster'
import { useToast } from './hooks/use-toast'

type UiMsg =
  | { id: string; kind: 'context-switch'; contextId: string | null; createdAt: number }
  | { id: string; kind: 'error'; content: string; createdAt: number }
  | { id: string; kind: 'msg'; role: 'user' | 'assistant'; content: string; widgetNode: ChatMessage['widgetNode']; createdAt: number }

const params = new URLSearchParams(location.search)
const device = params.get('device')
const code = params.get('code')
const qs = device && code ? `device=${encodeURIComponent(device)}&code=${encodeURIComponent(code)}` : null

/** HTTP 非 200 → 中文轻提示文案（中继/网络层错误统一入口）。 */
function describeHttpError(r: Response): string {
  if (r.status === 403) return '访问被拒绝：链接凭证无效或已失效，请回 PC 端重新复制链接'
  if (r.status === 429) return '请求过于频繁，已被临时限制，请稍后再试'
  if (r.status === 503) return '宿主离线：请确认电脑端 ProactiveAI 正在运行'
  if (r.status === 504) return '宿主响应超时，请稍后重试'
  return `请求失败（${r.status}）`
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [msgs, setMsgs] = useState<UiMsg[]>([])
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [retryInfo, setRetryInfo] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const { toast } = useToast()
  const activeIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const connectedRef = useRef(false)
  const esReconnecting = useRef(false)

  activeIdRef.current = activeId

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  const loadHistory = async (conversationId: string) => {
    const r = await fetch(`/api/history?${qs}&conversationId=${encodeURIComponent(conversationId)}`)
    if (!r.ok) throw new Error(`history ${r.status}`)
    const records = (await r.json()) as ChatMessage[]
    const ui: UiMsg[] = []
    for (const m of records) {
      if (m.kind === 'context-switch') {
        ui.push({ id: m.id, kind: 'context-switch', contextId: m.contextId, createdAt: m.createdAt })
      } else if (m.widgetNode) {
        ui.push({ id: m.id, kind: 'msg', role: 'assistant', content: '', widgetNode: m.widgetNode, createdAt: m.createdAt })
      } else if (m.content) {
        ui.push({ id: m.id, kind: 'msg', role: m.role, content: m.content, widgetNode: null, createdAt: m.createdAt })
      }
    }
    setMsgs(ui)
    scrollBottom()
  }

  const appendMsg = (m: UiMsg) => {
    setMsgs((prev) => [...prev, m])
    scrollBottom()
  }

  const handleEvent = (data: unknown) => {
    const evt = data as AgentStreamPushV1
    // 宿主在线状态广播（服务器在宿主 WS 注册/断开时发出，无 conversationId，先于会话过滤处理；
    // host-status 是中继自定义事件，不在 AgentStreamPushV1 协议内，故用局部断言）
    if ((evt as { kind?: string }).kind === 'host-status') {
      const online = !!(evt as { online?: boolean }).online
      connectedRef.current = online
      setConnected(online)
      if (online) {
        toast({ title: '宿主已连接' })
      } else {
        setBusy(false) // 宿主离线时在等的回复永远不会 done，必须复位
        toast({ title: '宿主已断开', description: '电脑端 ProactiveAI 未运行', variant: 'destructive' })
      }
      return
    }
    if (evt.conversationId !== activeIdRef.current) return
    switch (evt.kind) {
      case 'user-message':
        setBusy(true)
        appendMsg({ id: evt.messageId, kind: 'msg', role: 'user', content: evt.content, widgetNode: null, createdAt: evt.createdAt })
        break
      case 'stream': {
        if (evt.delta) {
          setMsgs((prev) => {
            const idx = prev.findIndex((m) => m.id === evt.runId)
            if (idx >= 0) {
              const updated = [...prev]
              const target = updated[idx]
              if (target.kind !== 'msg') return prev
              updated[idx] = { ...target, content: target.content + evt.delta }
              return updated
            }
            return [...prev, { id: evt.runId, kind: 'msg', role: 'assistant', content: evt.delta, widgetNode: null, createdAt: Date.now() }]
          })
          scrollBottom()
        }
        if (evt.done) setBusy(false)
        break
      }
      case 'ui_render':
        setBusy(true) // 回合尚未结束，保持 busy（done 统一复位）
        appendMsg({
          id: evt.runId,
          kind: 'msg',
          role: 'assistant',
          content: '',
          widgetNode: { type: evt.component as WidgetNode['type'], props: evt.props, children: evt.children },
          createdAt: Date.now(),
        })
        break
      case 'context-switch':
        appendMsg({ id: evt.runId, kind: 'context-switch', contextId: evt.contextId, createdAt: Date.now() })
        break
      case 'error':
        setBusy(false)
        appendMsg({ id: evt.runId, kind: 'error', content: evt.message, createdAt: Date.now() })
        break
    }
  }

  const connectSSE = () => {
    const es = new EventSource(`/api/events?${qs}`)
    es.onopen = () => {
      const wasReconnecting = esReconnecting.current
      esReconnecting.current = false
      connectedRef.current = true
      setConnected(true)
      if (wasReconnecting) toast({ title: '已重新连接' })
    }
    es.onmessage = (e) => {
      try {
        handleEvent(JSON.parse(e.data))
      } catch { /* 忽略坏帧 */ }
    }
    es.onerror = () => {
      es.close()
      if (connectedRef.current) toast({ title: '连接断开，正在重连…', variant: 'destructive' })
      connectedRef.current = false
      setConnected(false)
      esReconnecting.current = true
      setTimeout(connectSSE, 3000)
    }
  }

  // 初始化：状态 → 会话列表 → 最近活跃会话历史 → SSE。
  // 失败分级：403（凭证无效）不重试；其余（宿主还没连上中继/离线/网络）3s 间隔自动重试 5 次——
  // 覆盖"宿主刚重启、WS 尚未完成注册"的时序窗口，宿主连上后页面自动恢复
  useEffect(() => {
    if (!qs) {
      setPageError('缺少访问参数：请通过 PC 端设置页生成的完整链接打开（含 device 与 code）。')
      return
    }
    let cancelled = false
    const attempt = async (n: number): Promise<void> => {
      try {
        const st = await fetch(`/api/status?${qs}`)
        if (st.status === 403) {
          if (!cancelled) {
            setRetryInfo(null)
            setPageError('访问被拒绝：链接凭证无效或已失效，请回 PC 端重新复制链接。')
          }
          return
        }
        if (!st.ok) throw new Error(`status ${st.status}`)
        const data = (await st.json()) as { conversations: Conversation[] }
        const list = data.conversations ?? []
        if (list.length === 0) {
          if (!cancelled) {
            setRetryInfo(null)
            setPageError('暂无会话。请先在电脑上打开 ProactiveAI 开始聊天，再回到这里继续。')
          }
          return
        }
        const latest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0]
        if (cancelled) return
        setConversations(list)
        setActiveId(latest.id)
        await loadHistory(latest.id)
        if (cancelled) return
        setRetryInfo(null)
        connectSSE()
      } catch {
        // 503 宿主离线 / 504 超时 / 网络异常 → 可重试
        if (cancelled) return
        if (n >= 5) {
          setRetryInfo(null)
          setPageError('无法连接宿主。请确认电脑端 ProactiveAI 正在运行、中继连接为「已在线」后，刷新本页面重试。')
          return
        }
        setRetryInfo(`宿主暂未连接中继，正在重试 (${n}/5)…`)
        setTimeout(() => {
          if (!cancelled) void attempt(n + 1)
        }, 3000)
      }
    }
    void attempt(1)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = async (text: string) => {
    const trimmed = text.trim()
    if (!activeId || busy || !trimmed) return
    setBusy(true)
    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    try {
      const r = await fetch(`/api/send?${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: activeId, text: trimmed }),
      })
      const data = (await r.json().catch(() => ({}))) as { error?: string }
      if (!r.ok) {
        setBusy(false)
        toast({ title: describeHttpError(r), variant: 'destructive' })
        return
      }
      if (data.error) {
        setBusy(false)
        toast({ title: '发送失败', description: data.error, variant: 'destructive' })
        return
      }
      // 成功路径：busy 由 user-message（置 busy）→ stream done（复位）接管
    } catch {
      setBusy(false)
      toast({ title: '网络异常，请检查网络连接', variant: 'destructive' })
    }
  }

  const onInputKeydown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

  // 系统主题切换时同步 data-theme
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = (e: MediaQueryListEvent) => {
      document.documentElement.dataset.theme = e.matches ? 'dark' : 'light'
    }
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  // 时间戳（对齐宿主：当天 HH:mm:ss，跨天带日期）
  const stamp = (ts: number) => (
    <span className="mt-2 block text-[10px] text-[var(--app-muted)] opacity-60">{formatDate(ts)}</span>
  )

  if (pageError) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[var(--app-bg)] px-6 text-center text-sm text-[var(--app-muted)]">
        {pageError}
      </div>
    )
  }

  if (retryInfo) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[var(--app-bg)] px-6 text-center text-sm text-[var(--app-muted-fg)]">
        <div className="flex flex-col items-center gap-2">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-primary)]" />
          {retryInfo}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
      {/* 顶栏 */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-[var(--app-border)] bg-[var(--app-surface-muted)] px-4 py-3 backdrop-blur">
        <img src="/icon.png" alt="ProactiveAI" className="h-7 w-7 shrink-0 rounded-lg object-cover" />
        <span className="text-[15px] font-semibold tracking-tight">ProactiveAI</span>
        {conversations.length > 0 && (
          <div className="relative min-w-0 flex-1">
            <select
              value={activeId ?? ''}
              onChange={(e) => {
                const id = e.target.value
                setActiveId(id)
                setMsgs([])
                void loadHistory(id).catch(() => toast({ title: '历史加载失败：宿主可能已离线', variant: 'destructive' }))
              }}
              className="w-full appearance-none truncate rounded-lg border border-[var(--app-input-border)] bg-[var(--app-input-bg)] py-1.5 pl-3 pr-8 text-[13px] text-[var(--app-input-fg)] outline-none transition-shadow focus:border-[var(--app-primary)] focus:shadow-[0_0_0_3px_rgba(75,107,251,0.12)]"
            >
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || c.id.slice(0, 6)}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--app-muted-fg)]" />
          </div>
        )}
        <span
          className={`h-2 w-2 shrink-0 rounded-full transition-colors ${connected ? 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]' : 'bg-[var(--app-muted-fg)]/40'}`}
        />
      </header>

      {/* 聊天区容器（不滚动）：Toaster 的 viewport absolute 贴此容器右上，不随消息流滚动、不遮顶栏 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Toaster />
        {/* 消息流（flex 滚动关键：min-h-0） */}
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {msgs.map((m) => {
          if (m.kind === 'context-switch') {
            return (
              <div key={m.id} className="flex items-center gap-2.5 text-[11px] text-[var(--app-muted-fg)]">
                <span className="h-px flex-1 bg-[var(--app-border)]" />
                {m.contextId ? `进入「${m.contextId}」` : '回到主上下文'}
                <span className="h-px flex-1 bg-[var(--app-border)]" />
              </div>
            )
          }
          if (m.kind === 'error') {
            return (
              <div key={m.id} className="msg-in self-stretch rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-500">
                {m.content}
                {stamp(m.createdAt)}
              </div>
            )
          }
          if (m.widgetNode) {
            return (
              <div key={m.id} className="msg-in self-stretch">
                <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-3.5">
                  <WidgetRenderer node={m.widgetNode} onSend={(t) => void send(t)} />
                </div>
                {stamp(m.createdAt)}
              </div>
            )
          }
          if (m.role === 'user') {
            return (
              <div key={m.id} className="msg-in flex flex-col items-end">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--app-user-bubble)] px-3.5 py-2 text-sm">
                  {m.content}
                </div>
                {stamp(m.createdAt)}
              </div>
            )
          }
          const streaming = busy && m.id === msgs[msgs.length - 1]?.id
          return (
            <div key={m.id} className="msg-in flex max-w-full flex-col self-start">
              <div className={`w-full whitespace-pre-wrap break-words text-sm leading-relaxed ${streaming ? 'stream-caret' : ''}`}>
                <MarkdownView content={m.content} />
              </div>
              {stamp(m.createdAt)}
            </div>
          )
        })}
        </div>
      </div>

      {/* 输入栏 */}
      <footer className="flex shrink-0 items-end gap-2 border-t border-[var(--app-border)] bg-[var(--app-surface-footer)] p-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
          }}
          onKeyDown={onInputKeydown}
          rows={1}
          placeholder="输入消息…"
          className="max-h-[120px] flex-1 resize-none overflow-hidden rounded-xl border border-[var(--app-input-border)] bg-[var(--app-input-bg)] px-3.5 py-2.5 text-[15px] leading-5 text-[var(--app-input-fg)] outline-none transition-shadow placeholder:text-[var(--app-muted-fg)]/70 focus:border-[var(--app-primary)] focus:shadow-[0_0_0_3px_rgba(75,107,251,0.15)]"
        />
        <button
          type="button"
          disabled={busy || !activeId}
          onClick={() => void send(input)}
          className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-[var(--app-primary)] text-white transition-transform active:scale-[0.95] disabled:opacity-40"
          aria-label="发送"
        >
          <SendHorizontal size={17} />
        </button>
      </footer>
    </div>
  )
}