import { useEffect, useState } from 'react'
import { Button, DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SetupState } from './setup.ts'
import type { zh } from './locales.ts'

type Translate = (key: keyof typeof zh) => string

function parseState(value: unknown): SetupState & { token?: string } {
  if (typeof value !== 'object' || value === null || !('phase' in value) || typeof value.phase !== 'string'
    || !['idle', 'checking', 'downloading', 'verifying', 'extracting', 'ready', 'failed', 'cancelled'].includes(value.phase)
    || !('supported' in value) || typeof value.supported !== 'boolean'
    || !('version' in value) || typeof value.version !== 'string'
    || !('directory' in value) || typeof value.directory !== 'string'
    || !('source' in value) || typeof value.source !== 'string'
    || !('completedBytes' in value) || typeof value.completedBytes !== 'number'
    || ('totalBytes' in value && typeof value.totalBytes !== 'number')
    || ('error' in value && typeof value.error !== 'string')
    || ('token' in value && typeof value.token !== 'string')) throw new Error('Invalid editor preparation response')
  return value as SetupState & { token?: string }
}

/**
 * Render explicit host-side installation using the voice preparation controls.
 * @param props - Localized copy and current form write permission.
 * @returns Preparation card with progress, cancellation and retry actions.
 */
export function EditorSetup(props: { t: Translate; disabled: boolean }) {
  const { t, disabled } = props
  const [state, setState] = useState<SetupState>()
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [token, setToken] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const response = await fetch('/amadeus/editor/setup', { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body: unknown = await response.json()
        const next = parseState(body)
        if (!next.token) throw new Error('Missing setup authorization')
        if (controller.signal.aborted) return
        setState(next); setToken(next.token); setError('')
      } catch (failure) {
        if (!controller.signal.aborted) setError(String(failure))
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void refresh() }, 1000)
      }
    }
    void refresh()
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [])
  const run = async (action: 'install' | 'cancel'): Promise<void> => {
    setSubmitting(true)
    try {
      const response = await fetch(`/amadeus/editor/setup?action=${action}`, {
        method: 'POST', headers: { 'x-amadeus-setup-token': token },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body: unknown = await response.json()
      setState(parseState(body)); setExpanded(true)
    } catch (failure) { setError(String(failure)) }
    finally { setSubmitting(false) }
  }
  const steps = ['checking', 'downloading', 'verifying', 'extracting', 'ready'] as const
  const phase = state?.phase ?? 'idle'
  const active = ['checking', 'downloading', 'verifying', 'extracting'].includes(phase)
  const current = steps.findIndex(step => step === phase)
  const metric = state ? `${(state.completedBytes / 1_000_000).toFixed(1)} MB${state.totalBytes ? ` / ${(state.totalBytes / 1_000_000).toFixed(1)} MB` : ''}` : ''
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, margin: '12px 0',
    border: '0.5px solid var(--dsw-alias-border-l1)', borderRadius: 10, fontSize: 13 }}>
    <strong>{t('setupTitle')}{state && ` ${state.version}`}</strong>
    <p style={{ margin: 0 }}>{t('setupHelp')}</p>
    {state && <small style={{ color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' }}>
      {state.source}<br />{state.directory}
    </small>}
    <DisclosureRow title={t('setupSteps')} open={expanded} expandable expandOnRowClick previewChevron={false}
      icon={<StateDot appearance="step" size={16} state={phase === 'ready' ? 'done' : phase === 'failed' ? 'error' : active ? 'ongoing' : 'idle'} />}
      onToggle={() => { setExpanded(value => !value) }}>
      <ol style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14, padding: '16px 0 2px', margin: 0 }}>
        {steps.map((step, index) => <li key={step} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StateDot appearance="step" size={16} state={phase === 'ready' || (current > index) ? 'done' : current === index ? 'ongoing' : 'idle'} />
          <span>{t(`setup.${step}`)}</span>
        </li>)}
      </ol>
    </DisclosureRow>
    {phase === 'downloading' && <><span role="status">{metric}</span><progress aria-label={t('setupProgress')}
      style={{ width: '100%', height: 6 }} value={state?.totalBytes ? state.completedBytes : undefined} max={state?.totalBytes} /></>}
    {phase === 'ready' && <p role="status">{t('setupReady')}</p>}
    {phase === 'cancelled' && <p role="status">{t('setupCancelled')}</p>}
    {state && !state.supported && <p role="status">{t('setupUnsupported')}</p>}
    {(error || state?.error) && <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' }}>
      {t('setupFailed')} {error || state?.error}
    </p>}
    <div style={{ display: 'flex', gap: 8 }}>
      {phase !== 'ready' && !active && <Button variant="outline" size="sm" disabled={disabled || !state?.supported || !token || submitting}
        onClick={() => { void run('install') }}>{t(phase === 'failed' || phase === 'cancelled' ? 'setupRetry' : 'setupInstall')}</Button>}
      {active && <Button variant="ghost" size="sm" disabled={submitting || disabled}
        onClick={() => { void run('cancel') }}>{t('setupCancel')}</Button>}
    </div>
  </section>
}
