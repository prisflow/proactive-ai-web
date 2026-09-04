/**
 * Web 版渲染树渲染器 —— 与宿主 widget-system 同语义（Row/Column/Text/Button/Divider/Image）。
 * 与 PC 版的差异：Button 行为注入（onSend 回调）而非 zustand/Electron 依赖。
 *
 * 关键兼容：节点 type 允许缺失——历史重建（extraData.uiRender）与部分推送的 children
 * 只有 component 字段（PC 渲染器同样做了 component 回退）。
 */
import type { WidgetNode } from './types/ui'

export function WidgetRenderer({ node, onSend }: { node: WidgetNode; onSend: (text: string) => void }): React.ReactNode {
  const resolvedType = (node.type ?? (node as unknown as { component?: string }).component ?? '') as string
  const props = (node.props ?? {}) as Record<string, unknown>
  const p = props as Record<string, string | undefined>
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
      const action = p.action as { type?: string; text?: string } | undefined
      return (
        <button
          type="button"
          className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-button-secondary-bg)] px-4 py-2.5 text-sm text-[var(--app-button-secondary-fg)] transition-colors hover:bg-[var(--app-button-secondary-hover)] active:scale-[0.99]"
          onClick={() => {
            if (action?.type === 'send' && action.text) onSend(action.text)
          }}
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
          src={p.src ?? ''}
          alt={p.alt ?? ''}
          draggable={false}
          className={`max-w-full rounded-lg ${animCls} ${p.className ?? ''}`}
        />
      )
    }
    default: {
      if (kids.length === 0) return null
      return <div className="flex flex-col gap-1">{kids}</div>
    }
  }
}