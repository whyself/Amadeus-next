/** Minimal bundle that owns one effect: it logs when the Loader applies it and again when the plugin is disposed. */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'amadeus-example'

/**
 * Registers the load and unload log lines as one `ctx.effect()`, so disposing the plugin runs the unload line.
 * @param ctx - the plugin context that owns the effect.
 */
export function apply(ctx: Context) {
  ctx.effect(() => {
    console.log('[amadeus-example] plugin loaded')
    return () => {
      console.log('[amadeus-example] plugin disposed')
    }
  })
}
