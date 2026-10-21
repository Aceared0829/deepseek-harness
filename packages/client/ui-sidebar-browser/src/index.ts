/** Host companion for the Sidebar Browser Client plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BROWSER_CONFIG_GLOBAL, type Config } from './config.ts'

export { Config } from './config.ts'

/**
 * Mount the browser-only plugin through the Client loader, and embed its
 * deployment options in product pages before browser plugins activate.
 * @param ctx - Host context serving browser pages.
 * @param config - options the page adopts when it loads.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: BROWSER_CONFIG_GLOBAL, value: config })
  })
}
