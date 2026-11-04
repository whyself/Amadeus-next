import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, FormEvent, ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { editorCommand, fetchWorkspace, parseDirtyState, type EditorWorkspace } from './client-api.ts'
import { CloseCoordinator } from './client-close.ts'
import { confirmClose } from './client-dialog.ts'
import { EditorAction } from './client-action.tsx'
import { FramePool, type WorkspaceDirtyState } from './frame-pool.ts'
import { en, zh } from './locales.ts'

const KIND = 'amadeus-code-server'
const ID = '@amadeus-dsh/editor'
const ENTRY_ID = 'amadeus-editor'
const NS = 'amadeusEditor'
type CopyKey = keyof typeof zh

interface ConfigDraft {
  executablePath: string
  upstream: string
  stateDir: string
  publicOrigin: string
  bridgeMode: string
  startupTimeoutMs: string
  bridgeTimeoutMs: string
  maxHotWorkspaces: string
}

interface ConfigSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: Record<string, unknown> | undefined
  revision: number | undefined
  writable: boolean
}

type ConfigMutationOp = { op: 'set'; path: readonly [string]; value: unknown } | { op: 'unset'; path: readonly [string] }

interface ConfigFormHandle {
  getSnapshot(): ConfigSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly ConfigMutationOp[], expectedRevision?: number): Promise<boolean>
}

function emptyDraft(): ConfigDraft {
  return {
    executablePath: '',
    upstream: '',
    stateDir: '',
    publicOrigin: '',
    bridgeMode: '',
    startupTimeoutMs: '',
    bridgeTimeoutMs: '',
    maxHotWorkspaces: '',
  }
}

function draftFromValue(value: Record<string, unknown> | undefined): ConfigDraft {
  if (!value) return emptyDraft()
  const text = (key: string): string => (typeof value[key] === 'string' || typeof value[key] === 'number' ? String(value[key]) : '')
  return {
    executablePath: text('executablePath'),
    upstream: text('upstream'),
    stateDir: text('stateDir'),
    publicOrigin: text('publicOrigin'),
    bridgeMode: text('bridgeMode'),
    startupTimeoutMs: text('startupTimeoutMs'),
    bridgeTimeoutMs: text('bridgeTimeoutMs'),
    maxHotWorkspaces: text('maxHotWorkspaces'),
  }
}

const configStyles: Record<'form' | 'section' | 'heading' | 'description' | 'label' | 'input' | 'button' | 'primary' | 'footer', CSSProperties> = {
  form: { display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 640, color: 'var(--dsw-alias-label-primary, inherit)' },
  section: { display: 'flex', flexDirection: 'column', gap: 14 },
  heading: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 600 },
  description: { margin: 0, color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 13, lineHeight: '20px' },
  label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, fontWeight: 500 },
  input: {
    boxSizing: 'border-box', width: '100%', minHeight: 40, padding: '8px 12px', font: 'inherit',
    color: 'var(--dsw-alias-label-primary, inherit)', background: 'var(--dsw-alias-bg-layer-3, transparent)',
    border: '1px solid var(--dsw-alias-border-l4, #aaa)', borderRadius: 'var(--dsw-radius-md, 8px)',
  },
  button: {
    minHeight: 40, padding: '8px 16px', font: 'inherit', cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l4, #aaa)', borderRadius: 8,
    color: 'var(--dsw-alias-label-primary, inherit)', background: 'transparent',
  },
  primary: { background: 'var(--dsw-alias-button-primary-fill, #2b63d9)', color: 'var(--dsw-alias-label-primary-foreground, white)' },
  footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
}

function validOrigin(value: string): boolean {
  if (!value) return true
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash
  } catch {
    return false
  }
}

interface TabInfo {
  sidebar: { fullscreen: boolean }
  tab: { id: string; visible: boolean; navigation: { params?: { path?: string; address?: string; line?: number; column?: number } } }
}

function workbenchFolder(workspace: string): string {
  const normalized = workspace.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized
}

function filePath(value: string, sessionId: string): string {
  if (!value.startsWith('dsh-resource://')) return value
  const url = new URL(value)
  if (url.protocol !== 'dsh-resource:' || url.hostname !== 'file') throw new Error('Invalid file address')
  const [scope, ...segments] = url.pathname.slice(1).split('/').map(decodeURIComponent)
  if (scope === 'session') {
    if (segments.shift() !== sessionId || segments.length === 0) throw new Error('File belongs to another session')
    return segments.join('/')
  }
  if (scope === 'absolute' && segments.length > 0) {
    const result = segments.join('/')
    return /^[A-Za-z]:\//.test(result) ? result : `/${result}`
  }
  throw new Error('Invalid file address')
}

interface ClientHost {
  locale: {
    register(namespace: string, dictionaries: { zh: typeof zh; en: typeof en }): () => void
    bind(namespace: string): (key: CopyKey) => string
    subscribe(listener: () => void): () => void
    getSnapshot(): { readonly revision: number }
  }
  sidebarRightTabs: { register(definition: object): () => void }
  sidebarRight: {
    registerCloseHandler(kind: string, handler: (sessionId: string, tab: { id: string }) => void): () => void
    openTabIn(sessionId: string, kind: string, options?: object): void
    closeIn(sessionId: string, tabId: string): void
    tabsIn(sessionId: string): readonly { id: string; kind: string }[]
    commandTarget(element: Element | null): object | undefined
    openTabFromTarget(kind: string, target: object): void
  }
  shortcuts: { register(definition: object): () => void }
  slots: {
    inject(name: string, callback: () => () => void): () => void
    register(options: object, component: (props: never) => ReactElement): () => void
  }
  configForms?: {
    get(entryId: string): ConfigFormHandle
  }
}

/** Browser services required by the editor client. */
export const inject = ['locale', 'sidebarRight', 'sidebarRightTabs', 'slots', 'shortcuts', 'configForms']

/**
 * Register the editor's sidebar page, entry points and owned frame lifecycle.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  const host = ctx as Context & ClientHost
  const t = host.locale.bind(NS)
  const workspaces = new Map<string, EditorWorkspace>()
  const owners = new Map<string, string>()
  let pool: FramePool | undefined
  let stopped = false
  const owner = new AbortController()

  async function command(sessionId: string, workspace: string, action: string, signal: AbortSignal): Promise<unknown> {
    const entry = workspaces.get(sessionId)
    if (!entry) throw new Error('Editor session has no capability')
    return editorCommand('action', sessionId, workspace, { action }, signal, entry.bridgeToken)
  }

  async function clean(sessionId: string, workspace: string, action: string, signal: AbortSignal): Promise<void> {
    const result = await command(sessionId, workspace, action, signal)
    if (typeof result !== 'object' || result === null || !('clean' in result) || result.clean !== true) {
      throw new Error('Editor changes could not be cleared')
    }
  }

  async function state(sessionId: string, workspace: string, signal: AbortSignal): Promise<WorkspaceDirtyState> {
    const entry = workspaces.get(sessionId)
    if (entry?.bridgeMode === 'disabled') return { known: true, dirtyCount: 0, instanceCount: 1 }
    return parseDirtyState(await command(sessionId, workspace, 'dirtyState', signal))
  }

  function sessionFor(workspace: string): string {
    const sessionId = owners.get(workspace)
    if (!sessionId) throw new Error('Editor workspace has no session')
    return sessionId
  }

  function choose(current: WorkspaceDirtyState, signal: AbortSignal): Promise<'save' | 'discard' | 'cancel'> {
    return confirmClose(document, current, {
      title: t('title'), dirty: t('dirty'), multiple: t('multiple'),
      save: t('save'), discard: t('discard'), cancel: t('cancel'),
    }, signal)
  }

  const close = new CloseCoordinator({
    state,
    confirm: (_session, _workspace, current, signal) => choose(current, signal),
    async save(sessionId, workspace, signal) { await clean(sessionId, workspace, 'saveAll', signal) },
    async discard(sessionId, workspace, signal) { await clean(sessionId, workspace, 'revertAndClose', signal) },
    reopen(sessionId) { host.sidebarRight.openTabIn(sessionId, KIND) },
    close(sessionId) {
      const tab = host.sidebarRight.tabsIn(sessionId).find(item => item.kind === KIND)
      if (tab) host.sidebarRight.closeIn(sessionId, tab.id)
    },
    report() { window.alert(t('unknown')) },
  })

  function getPool(limit: number): FramePool {
    if (!pool) {
      pool = new FramePool(document, limit, {
        state: (workspace, signal) => state(sessionFor(workspace), workspace, signal),
        confirm: (_workspace, current, signal) => choose(current, signal),
        async save(workspace, signal) { await clean(sessionFor(workspace), workspace, 'saveAll', signal) },
        async discard(workspace, signal) { await clean(sessionFor(workspace), workspace, 'revertAndClose', signal) },
      })
    }
    return pool
  }

  function Body({ sessionId, useTabInfo }: { sessionId: string; useTabInfo: () => TabInfo }): ReactElement {
    const { tab, sidebar } = useTabInfo()
    const title = t('title')
    const anchor = useRef<HTMLDivElement>(null)
    const [workspace, setWorkspace] = useState<EditorWorkspace>()
    const [workbenchFrame, setWorkbenchFrame] = useState<HTMLIFrameElement>()
    const [readyFrame, setReadyFrame] = useState<HTMLIFrameElement>()
    const [error, setError] = useState(false)
    const [retry, setRetry] = useState(0)
    useEffect(() => {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, owner.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      let current: string | undefined
      const refresh = (): void => {
        if (!tab.visible) return
        void fetchWorkspace(sessionId, signal).then(async (value) => {
          signal.throwIfAborted()
          if (current === value.workspaceRoot && pool?.has(value.workspaceRoot)) return
          const frame = await getPool(value.maxHotWorkspaces).acquire(
            value.workspaceRoot, `${window.location.protocol === 'dsh-app:' ? `${value.editorOrigin}/` : '/amadeus/code/'}?${new URLSearchParams({ folder: workbenchFolder(value.workspaceRoot) })}`,
          )
          if (signal.aborted) return
          if (!frame) {
            setError(true)
            return
          }
          frame.title = t('title')
          current = value.workspaceRoot
          workspaces.set(sessionId, value)
          owners.set(value.workspaceRoot, sessionId)
          setWorkbenchFrame(frame)
          setWorkspace(value)
          setError(false)
        }).catch(() => { if (!signal.aborted) setError(true) }).finally(() => {
          if (!signal.aborted) timer = setTimeout(refresh, 5000)
        })
      }
      refresh()
      return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
    }, [sessionId, tab.visible, retry])
    useEffect(() => {
      if (!workspace || !workbenchFrame || readyFrame !== workbenchFrame || !anchor.current || !tab.visible) return
      const element = anchor.current
      const placement = {}
      let stopped = false
      let animationFrame: number | undefined
      const update = (): void => {
        if (stopped) return
        if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame)
        animationFrame = undefined
        let moving = false
        // Ancestor transforms move the placeholder without triggering ResizeObserver.
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.getAnimations().some(animation => animation.playState === 'running')) moving = true
        }
        pool?.place(workspace.workspaceRoot, element.getBoundingClientRect(), placement, title, sidebar.fullscreen ? 50 : 20)
        if (moving) animationFrame = window.requestAnimationFrame(update)
      }
      const transition = (event: Event): void => {
        if (event.target instanceof Element && event.target.contains(element)) update()
      }
      const events = ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel']
      const observer = new ResizeObserver(update)
      observer.observe(element)
      window.addEventListener('resize', update)
      window.addEventListener('scroll', update, true)
      for (const event of events) document.addEventListener(event, transition, true)
      update()
      return () => {
        stopped = true
        if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame)
        observer.disconnect()
        window.removeEventListener('resize', update)
        window.removeEventListener('scroll', update, true)
        for (const event of events) document.removeEventListener(event, transition, true)
        pool?.hide(workspace.workspaceRoot, placement)
      }
    }, [workspace, workbenchFrame, readyFrame, tab.visible, sidebar.fullscreen, title])
    useEffect(() => {
      if (!workspace || !tab.navigation.params || workspace.bridgeMode === 'disabled') return
      const { path: pathParam, address, line, column } = tab.navigation.params
      const target = pathParam ?? address
      if (!target) return
      let path: string
      try {
        path = filePath(target, sessionId)
      } catch {
        setError(true)
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, owner.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      let attempts = 0
      const open = (): void => {
        attempts++
        void editorCommand('open', sessionId, workspace.workspaceRoot, {
          action: 'openFile', path, ...line === undefined ? {} : { line }, ...column === undefined ? {} : { column },
        }, signal, workspace.bridgeToken).catch(() => {
          if (signal.aborted) return
          if (attempts < 30) timer = setTimeout(open, 500)
          else setError(true)
        })
      }
      open()
      return () => {
        controller.abort()
        if (timer !== undefined) clearTimeout(timer)
      }
    }, [sessionId, workspace, tab.navigation])
    useEffect(() => {
      if (!workspace || !workbenchFrame) return
      if (workspace.bridgeMode === 'disabled') {
        setReadyFrame(workbenchFrame)
        return
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, owner.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      const sync = (attempts = 0): void => {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined }
        const dark = document.documentElement.classList.contains('dark')
          || document.documentElement.dataset.theme === 'dark'
          || document.body.hasAttribute('data-ds-dark-theme')
        void editorCommand('settings', sessionId, workspace.workspaceRoot, {
          action: 'appearance', theme: dark ? 'Default Dark Modern' : 'Default Light Modern',
        }, signal, workspace.bridgeToken).then(() => {
          if (!signal.aborted) setReadyFrame(workbenchFrame)
        }).catch(() => {
          if (signal.aborted) return
          if (attempts + 1 < 30) timer = setTimeout(() => { sync(attempts + 1) }, 500)
          else setError(true)
        })
      }
      const observer = new MutationObserver(() => { sync() })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      sync()
      return () => {
        controller.abort()
        if (timer !== undefined) clearTimeout(timer)
        observer.disconnect()
      }
    }, [workspace, workbenchFrame, sessionId])
    return <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {error && <div role="alert" style={{ padding: 16 }}>
        <p>{t('error')}</p>
        {!workspace && <p>{t('connectionHelp')}</p>}
        <button type="button" onClick={() => { setError(false); setRetry(value => value + 1) }}>{t('retry')}</button>
      </div>}
      <div ref={anchor} style={{ flex: 1, minHeight: 0 }} role={workspace ? undefined : 'status'}>
        {(!workspace || readyFrame !== workbenchFrame) && !error && t('loading')}
      </div>
    </div>
  }

  function Entry({ sessionId, absolutePath }: { sessionId: string; absolutePath: string }): ReactElement {
    return <EditorAction label={t('editFile')} description={t('openFile')}
      open={() => { host.sidebarRight.openTabIn(sessionId, KIND, { params: { path: absolutePath } }) }} />
  }

  function WorkspaceEntry({ sessionId }: { sessionId: string }): ReactElement {
    return <EditorAction label={t('openEditor')} description={t('openWorkspace')}
      open={() => { host.sidebarRight.openTabIn(sessionId, KIND) }} />
  }

  function ConfigSection({ view }: { view?: 'summary' | 'page' }): ReactElement {
    const locale = useMemo(() => ({
      subscribe: (listener: () => void) => host.locale.subscribe(listener),
      getSnapshot: () => host.locale.getSnapshot().revision,
    }), [])
    useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot)
    const form = useMemo(() => host.configForms?.get(ENTRY_ID), [])
    const [snapshot, setSnapshot] = useState<ConfigSnapshot | undefined>(() => form?.getSnapshot())
    const [draft, setDraft] = useState<ConfigDraft>(() => draftFromValue(form?.getSnapshot().value))
    const [external, setExternal] = useState(() => Boolean(draft.upstream))
    const [saving, setSaving] = useState(false)
    const [feedback, setFeedback] = useState<'saved' | 'failed' | 'invalidUrl' | 'invalidNumber' | 'externalRequired'>()
    const [changed, setChanged] = useState(false)
    const dirty = useRef(false)
    const mounted = useRef(false)
    const baseline = useRef({ draft, external: Boolean(draft.upstream), revision: snapshot?.revision })

    useEffect(() => {
      mounted.current = true
      return () => { mounted.current = false }
    }, [])

    useEffect(() => {
      if (!form) return
      const sync = (): void => {
        const next = form.getSnapshot()
        setSnapshot(next)
        if (!dirty.current) {
          const nextDraft = draftFromValue(next.value)
          const nextExternal = Boolean(nextDraft.upstream)
          setDraft(nextDraft)
          setExternal(nextExternal)
          baseline.current = { draft: nextDraft, external: nextExternal, revision: next.revision }
          setChanged(false)
        } else if (next.revision !== baseline.current.revision) {
          setChanged(true)
        }
      }
      sync()
      return form.subscribe(sync)
    }, [form])

    if (view === 'summary') return <p>{t('configIntro')}</p>
    if (!form || !snapshot || snapshot.status === 'unavailable') {
      return <p role="status">{t('configUnavailable')}</p>
    }
    if (snapshot.status === 'loading') return <p role="status">{t('configLoading')}</p>

    const disabled = !snapshot.writable || saving
    const updateField = (key: keyof ConfigDraft, value: string): void => {
      dirty.current = true
      setFeedback(undefined)
      setDraft(prev => ({ ...prev, [key]: value }))
    }

    const reload = (): void => {
      const next = form.getSnapshot()
      const nextDraft = draftFromValue(next.value)
      const nextExternal = Boolean(nextDraft.upstream)
      dirty.current = false
      baseline.current = { draft: nextDraft, external: nextExternal, revision: next.revision }
      setSnapshot(next)
      setDraft(nextDraft)
      setExternal(nextExternal)
      setChanged(false)
      setFeedback(undefined)
    }

    const submit = (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault()
      if (disabled || changed) return
      const ops: ConfigMutationOp[] = []
      if (external && !draft.upstream.trim()) { setFeedback('externalRequired'); return }
      if ((external && !validOrigin(draft.upstream.trim())) || !validOrigin(draft.publicOrigin.trim())) {
        setFeedback('invalidUrl')
        return
      }
      for (const key of ['executablePath', 'upstream', 'stateDir', 'publicOrigin'] as const) {
        const trimmed = key === 'upstream' && !external ? '' : draft[key].trim()
        const original = key === 'upstream' && !baseline.current.external ? '' : baseline.current.draft[key].trim()
        if (trimmed === original) continue
        ops.push(trimmed === '' ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: trimmed })
      }
      const mode = draft.bridgeMode.trim()
      if (mode !== baseline.current.draft.bridgeMode.trim()) {
        if (mode === '') ops.push({ op: 'unset', path: ['bridgeMode'] })
        else if (mode === 'required' || mode === 'disabled') ops.push({ op: 'set', path: ['bridgeMode'], value: mode })
        else { setFeedback('failed'); return }
      }
      for (const key of ['startupTimeoutMs', 'bridgeTimeoutMs', 'maxHotWorkspaces'] as const) {
        const trimmed = draft[key].trim()
        if (trimmed === '') {
          if (trimmed === baseline.current.draft[key].trim()) continue
          ops.push({ op: 'unset', path: [key] })
          continue
        }
        const parsed = Number(trimmed)
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          setFeedback('invalidNumber')
          return
        }
        if (trimmed === baseline.current.draft[key].trim()) continue
        ops.push({ op: 'set', path: [key], value: parsed })
      }
      if (ops.length === 0) { setFeedback('saved'); return }
      setSaving(true)
      setFeedback(undefined)
      void form.mutate(ops, baseline.current.revision).then((accepted) => {
        if (!owner.signal.aborted && mounted.current) {
          if (accepted) {
            reload()
            setFeedback('saved')
          } else setFeedback('failed')
        }
      }).catch(() => {
        if (!owner.signal.aborted && mounted.current) setFeedback('failed')
      }).finally(() => {
        if (!owner.signal.aborted && mounted.current) setSaving(false)
      })
    }

    const field = (key: keyof ConfigDraft, label: CopyKey, help: CopyKey, type: 'text' | 'number' = 'text'): ReactElement =>
      <label style={configStyles.label}>
        <span>{t(label)}</span>
        <span style={configStyles.description}>{t(help)}</span>
        <input style={configStyles.input} type={type} min={type === 'number' ? 1 : undefined} step={type === 'number' ? 1 : undefined}
          value={draft[key]} disabled={disabled} onChange={(event) => { updateField(key, event.target.value) }} />
      </label>

    return <form onSubmit={submit} style={configStyles.form} noValidate>
      <div style={configStyles.section}>
        <h3 style={configStyles.heading}>{t('configHeading')}</h3>
        <p style={configStyles.description}>{t('configIntro')}</p>
      </div>
      <div style={configStyles.section}>
        <label style={configStyles.label}>
          <span>{t('configConnection')}</span>
          <span style={configStyles.description}>{t('configConnectionDescription')}</span>
          <select style={configStyles.input} value={external ? 'external' : 'managed'} disabled={disabled}
            onChange={(event) => { dirty.current = true; setFeedback(undefined); setExternal(event.target.value === 'external') }}>
            <option value="managed">{t('configManaged')}</option>
            <option value="external">{t('configExternal')}</option>
          </select>
        </label>
        {external
          ? field('upstream', 'configUpstream', 'configUpstreamHelp')
          : field('executablePath', 'configExecutablePath', 'configExecutableHelp')}
      </div>
      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('configAdvanced')}</summary>
        <div style={{ ...configStyles.section, marginTop: 16 }}>
          <p style={configStyles.description}>{t('configAdvancedDescription')}</p>
          {field('stateDir', 'configStateDir', 'configStateDirHelp')}
          {field('publicOrigin', 'configPublicOrigin', 'configPublicOriginHelp')}
          <label style={configStyles.label}>
            <span>{t('configBridgeMode')}</span>
            <span style={configStyles.description}>{t('configBridgeHelp')}</span>
            <select style={configStyles.input} value={draft.bridgeMode} disabled={disabled} onChange={(event) => { updateField('bridgeMode', event.target.value) }}>
              <option value="">{t('configBridgeDefault')}</option>
              <option value="required">{t('configBridgeRequired')}</option>
              <option value="disabled">{t('configBridgeDisabled')}</option>
            </select>
          </label>
          {field('startupTimeoutMs', 'configStartupTimeoutMs', 'configStartupTimeoutHelp', 'number')}
          {field('bridgeTimeoutMs', 'configBridgeTimeoutMs', 'configBridgeTimeoutHelp', 'number')}
          {field('maxHotWorkspaces', 'configMaxHotWorkspaces', 'configMaxHotWorkspacesHelp', 'number')}
        </div>
      </details>
      {!snapshot.writable && <p role="status" style={configStyles.description}>{t('configReadOnly')}</p>}
      {changed && <div role="alert" style={configStyles.footer}>
        <span>{t('configChanged')}</span>
        <button type="button" style={configStyles.button} disabled={saving} onClick={reload}>{t('configReload')}</button>
      </div>}
      <div style={configStyles.footer}>
        <button type="submit" style={{ ...configStyles.button, ...configStyles.primary, opacity: disabled || changed ? 0.45 : 1 }}
          disabled={disabled || changed}>{t(saving ? 'configSaving' : 'configSave')}</button>
        {feedback && <span role={feedback === 'saved' ? 'status' : 'alert'}>
          {t(feedback === 'saved' ? 'configSaved' : feedback === 'invalidUrl' ? 'configInvalidUrl'
            : feedback === 'invalidNumber' ? 'configInvalidNumber' : feedback === 'externalRequired' ? 'configExternalRequired' : 'configSaveFailed')}
        </span>}
      </div>
    </form>
  }

  ctx.effect(() => {
    const cleanups: (() => void)[] = []
    const dispose = (): void => {
      stopped = true
      owner.abort()
      close.dispose()
      const errors: unknown[] = []
      for (const cleanup of cleanups.reverse()) {
        try { cleanup() } catch (error) { errors.push(error) }
      }
      pool?.dispose()
      workspaces.clear()
      owners.clear()
      if (errors.length) throw new AggregateError(errors, 'Editor client cleanup failed')
    }
    try {
      cleanups.push(host.locale.register(NS, { zh, en }))
      cleanups.push(host.sidebarRightTabs.register({
        id: ID, kind: KIND, title: () => t('title'), keepMounted: true,
        guide: [{ id: 'editor', order: 15, title: () => t('title'), description: () => t('description'), commandId: 'workspace.editor' }],
      }))
      cleanups.push(host.shortcuts.register({
        id: 'workspace.editor', label: () => t('title'), aliases: [],
        defaults: {
          'desktop:macos': { code: 'KeyE', modifiers: ['primary'] },
          'desktop:windows': { code: 'KeyE', modifiers: ['primary'] },
          'desktop:linux': { code: 'KeyE', modifiers: ['primary'] },
          'web:macos': { code: 'KeyE', modifiers: ['primary', 'alt'] },
          'web:windows': { code: 'KeyE', modifiers: ['primary', 'alt'] },
        },
        regions: ['page', 'editable', 'terminal'], modals: [],
        resolve: ({ target }: { target: Element | null }) => {
          const destination = host.sidebarRight.commandTarget(target)
          return destination
            ? { status: 'handled', run: () => { host.sidebarRight.openTabFromTarget(KIND, destination) } }
            : { status: 'blocked', reason: t('error') }
        },
      }))
      cleanups.push(host.slots.inject('sidebar.right.pane.tab', () => host.slots.register(
        { name: 'sidebar.right.pane.tab', key: ID, locale: NS }, Body,
      )))
      for (const name of ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable']) {
        cleanups.push(host.slots.inject(name, () => host.slots.register({ name, id: ID, locale: NS }, Entry)))
      }
      cleanups.push(host.slots.inject('sidebar.right.tab.files.actions', () => host.slots.register(
        { name: 'sidebar.right.tab.files.actions', id: ID, locale: NS }, WorkspaceEntry,
      )))
      cleanups.push(host.slots.inject('plugins.bundle.config', () => host.slots.register(
        { name: 'plugins.bundle.config', key: ID, locale: NS }, ConfigSection,
      )))
      cleanups.push(host.sidebarRight.registerCloseHandler(KIND, (sessionId) => {
        const workspace = workspaces.get(sessionId)
        if (!stopped && workspace) close.closeRequested(sessionId, workspace.workspaceRoot)
      }))
    } catch (error) {
      dispose()
      throw error
    }
    return dispose
  }, 'amadeus-editor client')
}
