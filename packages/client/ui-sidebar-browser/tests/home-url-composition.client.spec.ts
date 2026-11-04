// @vitest-environment jsdom
/** The served index's config row reaches the browser half and opens the tab. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import type { BrowserInjected } from '../src/client/browser/BrowserController.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import { apply as applyClient, inject } from '../src/client/index.ts'
import { BROWSER_CONFIG_GLOBAL, Config } from '../src/config.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  delete (globalThis as { __DSH_SIDEBAR_BROWSER_CONFIG__?: unknown }).__DSH_SIDEBAR_BROWSER_CONFIG__
})

/**
 * Adopt the browser options exactly as a served page does: read the value out
 * of the rendered index assignment, then publish it as the page global.
 */
function adoptIndexGlobal(html: string, name: string): void {
  const assignment = new RegExp(`globalThis\\["${name}"\\] = (?<value>.*?)</script>`, 'u').exec(html)
  if (assignment?.groups?.value === undefined) throw new Error(`the served index carries no ${name} assignment`)
  ;(globalThis as Record<string, unknown>)[name] = JSON.parse(assignment.groups.value)
}

async function bootClient() {
  const ctx = new Context()
  contexts.push(ctx)
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: { name: string; inject?: unknown }[] = []
  const target = { sessionId: 'session', paneId: 'pane' }
  ctx.provide('sidebarRight', {
    openTabs: createSnapshotStore<readonly { sessionId: string; tabId: TabId }[]>([]),
    commandTarget: () => target, openTabFromTarget: () => {},
  } as never)
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: { name: string; inject?: unknown }) => {
      registered.push(options)
      return () => {}
    },
  } as never)
  ctx.provide('locale', { bind: () => (key: string) => key, register: () => () => {} } as never)
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('workspaces', { list: createSnapshotStore({ phase: 'ready', items: [] }) } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply: applyClient })
  await fiber.await()
  const face = registered.find(entry => entry.name === 'sidebar.right.pane.tab')!.inject as
    (sessionId: string, actions: ReturnType<ReturnType<typeof createBrowserStore>['create']>['actions']) => BrowserInjected
  return { fiber, face }
}

/**
 * Publish the config row the Host entry contributes, in the shape the served
 * index renders: the Host spec pins that row, and this spec starts from it.
 */
function serveConfig(configured: Parameters<typeof Config>[0]): void {
  const rows: IndexInjection[] = [{ kind: 'global', name: BROWSER_CONFIG_GLOBAL, value: Config(configured) }]
  adoptIndexGlobal(renderIndexInjections('<html><head></head><body></body></html>', rows), BROWSER_CONFIG_GLOBAL)
}

describe('Sidebar Browser default address through the served index', () => {
  it('opens the configured home address in a new tab', async () => {
    serveConfig({ homeUrl: 'https://example.test/start' })
    const { face } = await bootClient()
    const host = document.createElement('div')
    host.id = 'home-url-composition'
    document.body.append(host)
    const signal = new AbortController()
    const controller = face('session', createBrowserStore().create('home-url-composition').actions)
    try {
      controller.mount({ tabId: 'tab' as TabId, signal: signal.signal, viewportId: host.id,
        applicationOrigin: 'https://dsh.example', initial: undefined, initialUrl: undefined, openTab: vi.fn() })
      expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://example.test/start')
    } finally {
      signal.abort()
      host.remove()
    }
  })

  it('opens Google by default when the Host sets no address', async () => {
    serveConfig({})
    const { face } = await bootClient()
    const host = document.createElement('div')
    host.id = 'home-url-default'
    document.body.append(host)
    const signal = new AbortController()
    const controller = face('session', createBrowserStore().create('home-url-default').actions)
    try {
      controller.mount({ tabId: 'tab' as TabId, signal: signal.signal, viewportId: host.id,
        applicationOrigin: 'https://dsh.example', initial: undefined, initialUrl: undefined, openTab: vi.fn() })
      // Address parsing normalizes the configured origin to a trailing slash.
      expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://www.google.com/')
    } finally {
      signal.abort()
      host.remove()
    }
  })

  it('keeps the start placeholder when the Host sets an empty address', async () => {
    serveConfig({ homeUrl: '' })
    const { face } = await bootClient()
    const host = document.createElement('div')
    host.id = 'home-url-empty'
    document.body.append(host)
    const signal = new AbortController()
    const controller = face('session', createBrowserStore().create('home-url-empty').actions)
    try {
      controller.mount({ tabId: 'tab' as TabId, signal: signal.signal, viewportId: host.id,
        applicationOrigin: 'https://dsh.example', initial: undefined, initialUrl: undefined, openTab: vi.fn() })
      expect(host.querySelector('iframe')).toBeNull()
    } finally {
      signal.abort()
      host.remove()
    }
  })
})
