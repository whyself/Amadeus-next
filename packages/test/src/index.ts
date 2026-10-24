/** Minimal bundle that logs once when the Loader applies it. */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'amadeus-test'

/**
 * Logs a load message; the plugin registers nothing.
 * @param _ctx The plugin context, unused.
 */
export function apply(_ctx: Context) {
  console.log('[amadeus-test] plugin loaded!')
}
