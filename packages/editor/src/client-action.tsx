import type { ReactElement } from 'react'

const styles = `
.amadeus-editor-action {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l3, currentColor);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.amadeus-editor-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, ButtonFace);
}
.amadeus-editor-action:active {
  background: var(--dsw-alias-interactive-bg-active, ButtonFace);
}
.amadeus-editor-action:focus-visible {
  outline: 2px solid Highlight;
  outline-offset: 2px;
}
.amadeus-editor-action svg { flex: none; pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  .amadeus-editor-action { transition: none; }
}
`

/**
 * Render a compact editor entry with a localized tooltip and keyboard focus state.
 * @param props - Localized compact label, full action description and opening callback.
 * @returns The editor action and its component-owned styles.
 */
export function EditorAction(props: { label: string; description: string; open: () => void }): ReactElement {
  return <>
    <style>{styles}</style>
    <button type="button" className="amadeus-editor-action" title={props.description} aria-label={props.description} onClick={props.open}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="m5 4-4 4 4 4m6-8 4 4-4 4M9.5 2.5l-3 11" />
      </svg>
      <span>{props.label}</span>
    </button>
  </>
}
