/** Browser tab defaults shared by the Host configuration and the browser page. */
import z from '@deepseek-ai/schemastery'

/** Validated Browser deployment options. */
export interface Config {
  /** Address a new Browser tab opens when the tab carries no URL and has no saved page; empty keeps the start placeholder. */
  homeUrl: string
}

/** Validate deployment options and apply their defaults. */
export const Config: z<Partial<Config>, Config> = z.object({
  homeUrl: z.string().pattern(/^(?:https?:\/\/\S+)?$/u).default('https://www.google.com'),
})

/** Page-global key carrying only the public Browser options. */
export const BROWSER_CONFIG_GLOBAL = '__DSH_SIDEBAR_BROWSER_CONFIG__'
