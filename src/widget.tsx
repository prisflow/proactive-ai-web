/**
 * Web 端渲染器（渲染树 → React 组件）—— 与桌面端 widget-system 同一套协议
 * （Row/Column/Text/Button/Divider/Image/Progress/Table/Card/Badge/List/Code/Form/Confirm/Icon/Loading）。
 * 与 PC 端的差异：交互动作改为注入（onSend 回调注入，绕开 zustand/Electron 依赖）。
 *
 * 兼容性约定：节点 type 字段缺失时回读旧历史记录（extraData.uiRender）的半兼容字段 component。
 */
import { useState } from 'react'
import type { WidgetNode } from './types/ui'
import { icons } from 'lucide-react'

/** 交互动作：与桌面端 widget-system 的 WidgetAction 同构。 */
interface WidgetAction {
  type: 'send'
  text?: string
  payload?: Record<string, unknown>
}

/** 由 action 组装回灌文本：text 优先；payload 聚合为 JSON 透传（与桌面端一致）。 */
function buildActionText(action: WidgetAction, fallbackTitle?: string): string | null {
  if (action.type !== 'send') return null
  if (action.text) return action.text
  if (action.payload && Object.keys(action.payload).length > 0) {
    const title = fallbackTitle ? `【组件交互】${fallbackTitle}` : '【组件交互】'
    return `${title}\n${JSON.stringify(action.payload)}`
  }
  return fallbackTitle ?? null
}

/** Form 字段定义。 */
interface WidgetFormField {
  name: string
  label: string
  kind: 'select' | 'text' | 'number' | 'checkbox'
  options?: string[]
  placeholder?: string
  required?: boolean
  min?: number
  max?: number
  default?: string | number | boolean
}

const FIELD_CLASS = 'w-full rounded-lg border border-[var(--app-border)] bg-transparent px-2.5 py-1.5 text-xs text-[var(--app-fg)] outline-none focus:border-[var(--app-accent,#6366f1)]'

export function WidgetRenderer({ node, onSend }: { node: WidgetNode; onSend: (text: string) => void }): React.ReactNode {
  const resolvedType = (node.type ?? (node as unknown as { component?: string }).component ?? '') as string
  const props = (node.props ?? {}) as Record<string, unknown>
  const p = props as Record<string, string | number | undefined>
  const children = node.children
  const kids = (children ?? []).map((c, i) => <WidgetRenderer key={i} node={c} onSend={onSend} />)

  switch (resolvedType) {
    case 'Row':
      return <div className="flex flex-row flex-wrap items-center gap-2">{kids}</div>
    case 'Column':
      return <div className="flex flex-col gap-1">{kids}</div>
    case 'Text': {
      const size = (p.size as 'xs' | 'sm' | 'md' | 'lg' | undefined) ?? 'sm'
      const cls = { xs: 'text-[10px]', sm: 'text-xs', md: 'text-sm', lg: 'text-base font-semibold' }[size] ?? 'text-xs'
      return <span className={`${cls} whitespace-pre-wrap break-words text-[var(--app-fg)]`}>{p.content ?? ''}</span>
    }
    case 'Button': {
      const action = p.action as WidgetAction | undefined
      const text = action ? buildActionText(action, String(p.content ?? '')) : null
      return (
        <button
          type="button"
          className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-button-secondary-bg)] px-4 py-2.5 text-sm text-[var(--app-button-secondary-fg)] transition-colors hover:bg-[var(--app-button-secondary-hover)] active:scale-[0.99]"
          onClick={() => { if (text) onSend(text) }}
        >
          {p.content ?? ''}
        </button>
      )
    }
    case 'Divider':
      return <div className="h-px w-full bg-[var(--app-border)]" />
    case 'Image': {
      const anim = p.animation as string | undefined
      const animCls = anim === 'bounce' ? 'animate-bounce' : anim === 'pulse' ? 'animate-pulse' : anim === 'float' ? 'animate-bounce' : ''
      return (
        <img
          src={String(p.src ?? '')}
          alt={String(p.alt ?? '')}
          draggable={false}
          style={typeof p.width === 'number' ? { width: p.width } : undefined}
          className={`max-w-full rounded-lg ${animCls} ${String(p.className ?? '')}`}
        />
      )
    }
    case 'Progress': {
      const value = typeof p.value === 'number' ? p.value : 0
      const max = typeof p.max === 'number' && p.max > 0 ? p.max : 100
      const pct = Math.min(100, Math.max(0, (value / max) * 100))
      const color = String(p.color ?? 'default')
      const bar: Record<string, string> = {
        default: 'bg-[var(--app-accent,#6366f1)]',
        success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-red-500',
      }
      return (
        <div className="w-full">
          <div className="mb-0.5 flex justify-between text-[10px] opacity-70">
            <span>{String(p.label ?? '')}</span>
            <span>{value}/{max}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
            <div className={`h-full rounded-full ${bar[color] || bar.default}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )
    }
    case 'Table': {
      const columns = (p.columns as Array<{ key: string; label?: string; width?: number }> | undefined) ?? []
      const rows = (p.rows as Array<Record<string, unknown>> | undefined) ?? []
      if (!columns.length || !rows.length) return null
      return (
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={c.key || i} style={c.width ? { width: c.width } : undefined}
                    className="border-b border-[var(--app-border)] px-2 py-1 text-left font-medium opacity-70">
                    {c.label || c.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-b border-[var(--app-border)] last:border-0">
                  {columns.map((c, ci) => <td key={c.key || ci} className="px-2 py-1 align-top">{String(row[c.key] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'Card':
      return (
        <div className="w-full rounded-xl border border-[var(--app-border)] p-3">
          {p.title ? <div className="mb-1.5 text-xs font-medium opacity-80">{p.title}</div> : null}
          <div className="flex flex-col gap-1">{kids}</div>
        </div>
      )
    case 'Badge': {
      const variant = String(p.variant ?? 'default')
      const vcls: Record<string, string> = {
        default: 'bg-black/10 dark:bg-white/15',
        success: 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400',
        warning: 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
        danger: 'bg-red-500/20 text-red-600 dark:text-red-400',
      }
      const text = String(p.text ?? '')
      if (!text) return null
      return <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] ${vcls[variant] || vcls.default}`}>{text}</span>
    }
    case 'List': {
      const items = (p.items as string[] | undefined) ?? []
      if (!items.length) return null
      const Tag = p.ordered ? 'ol' : 'ul'
      return (
        <Tag className={`flex flex-col gap-0.5 pl-4 text-xs ${p.ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, i) => <li key={i}>{it}</li>)}
        </Tag>
      )
    }
    case 'Code': {
      const content = String(p.content ?? '')
      if (!content) return null
      return (
        <div className="w-full overflow-x-auto rounded-lg bg-black/85 p-2.5">
          {p.lang ? <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">{p.lang}</div> : null}
          <pre className="text-xs leading-relaxed text-white/90"><code className="font-mono">{content}</code></pre>
        </div>
      )
    }
    case 'Form':
      return <WidgetFormInline p={props} onSend={onSend} />
    case 'Confirm':
      return <WidgetConfirmInline p={props} onSend={onSend} />
    case 'Icon': {
      const name = String(p.name ?? '')
      const I = (icons as Record<string, React.ComponentType<{ size?: number; color?: string; className?: string }>>)[name]
      if (!I) return null
      return <I size={typeof p.size === 'number' ? p.size : 16} color={p.color ? String(p.color) : undefined} className={String(p.className ?? '')} />
    }
    case 'Loading':
      return (
        <div className="flex items-center gap-2 text-xs opacity-70">
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {String(p.label ?? '')}
        </div>
      )
    default: {
      if (kids.length === 0) return null
      return <div className="flex flex-col gap-1">{kids}</div>
    }
  }
}

/** 表单（内联组件）：多控件聚合提交，字段值收进 action.payload 一次回灌。 */
function WidgetFormInline({ p, onSend }: { p: Record<string, unknown>; onSend: (text: string) => void }): React.ReactNode {
  const fields = (p.fields as WidgetFormField[] | undefined) ?? []
  const action = p.action as WidgetAction | undefined
  const title = p.title ? String(p.title) : undefined
  const submitLabel = String(p.submitLabel ?? '提交')
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
    const init: Record<string, string | number | boolean> = {}
    for (const f of fields) {
      if (f.default !== undefined) init[f.name] = f.default
      else if (f.kind === 'checkbox') init[f.name] = false
      else if (f.kind === 'number') init[f.name] = f.min ?? 0
      else init[f.name] = ''
    }
    return init
  })

  if (!fields.length) return null

  const set = (name: string, v: string | number | boolean) => setValues((prev) => ({ ...prev, [name]: v }))

  const submit = () => {
    if (!action || action.type !== 'send') return
    const text = buildActionText({ type: 'send', text: action.text, payload: { ...(action.payload ?? {}), ...values } }, title ?? submitLabel)
    if (text) onSend(text)
  }

  return (
    <div className="w-full rounded-xl border border-[var(--app-border)] p-3">
      {title ? <div className="mb-2 text-xs font-medium opacity-80">{title}</div> : null}
      <div className="flex flex-col gap-2">
        {fields.map((f) => (
          <label key={f.name} className="flex flex-col gap-1">
            <span className="text-[10px] opacity-70">{f.label}{f.required ? ' *' : ''}</span>
            {f.kind === 'select' ? (
              <select className={FIELD_CLASS} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)}>
                <option value="">请选择…</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.kind === 'checkbox' ? (
              <input type="checkbox" className="h-4 w-4 accent-[var(--app-accent,#6366f1)]"
                checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
            ) : (
              <input type={f.kind === 'number' ? 'number' : 'text'} className={FIELD_CLASS}
                placeholder={f.placeholder} min={f.min} max={f.max}
                value={String(values[f.name] ?? '')}
                onChange={(e) => set(f.name, f.kind === 'number' ? Number(e.target.value) : e.target.value)} />
            )}
          </label>
        ))}
        <button type="button" onClick={submit}
          className="mt-1 w-full rounded-lg bg-[var(--app-accent,#6366f1)] px-4 py-2 text-sm text-white hover:opacity-90">
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

/** 确认对（内联组件）：确认/取消两个独立动作。 */
function WidgetConfirmInline({ p, onSend }: { p: Record<string, unknown>; onSend: (text: string) => void }): React.ReactNode {
  const confirmAction = p.confirmAction as WidgetAction | undefined
  const cancelAction = p.cancelAction as WidgetAction | undefined
  const confirmLabel = String(p.confirmLabel ?? '确认')
  const cancelLabel = String(p.cancelLabel ?? '取消')

  const btn = (label: string, action: WidgetAction | undefined, extra?: string) => {
    const text = action ? buildActionText(action, label) : null
    return (
      <div className="flex-1">
        <button type="button"
          className={`w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-button-secondary-bg)] px-4 py-2 text-sm text-[var(--app-button-secondary-fg)] hover:bg-[var(--app-button-secondary-hover)] ${extra ?? ''}`}
          onClick={() => { if (text) onSend(text) }}>
          {label}
        </button>
      </div>
    )
  }

  return (
    <div className="w-full rounded-xl border border-[var(--app-border)] p-3">
      {p.title ? <div className="mb-1 text-xs font-medium">{p.title}</div> : null}
      {p.content ? <div className="mb-2 text-xs opacity-70">{p.content}</div> : null}
      <div className="flex gap-2">
        {btn(confirmLabel, confirmAction)}
        {btn(cancelLabel, cancelAction, 'opacity-70')}
      </div>
    </div>
  )
}
