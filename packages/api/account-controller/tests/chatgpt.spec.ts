/** Subscription queries share model credentials and project only account display data. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { RemoteInvocation, PeerId } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatGptSignInAnswer } from '../src/types.ts'
import { credentialStoreFrom, recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatGptController } from '../src/chatgpt.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function fixture(signedIn = true) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-account-'))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  const store = credentialStoreFrom(ctx)
  const access = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'subscription-account' } })).toString('base64url')}.signature`
  if (signedIn) await store.modify('openai-codex', async () => ({ type: 'oauth', access, refresh: 'private-refresh', expires: Date.now() + 3600000 }))
  return { ctx, controller: new ChatGptController(ctx, { chatGptUsageEndpoint: 'https://chatgpt.com/backend-api/wham/usage', chatGptTimeoutMs: 20000 }), store, access }
}

function conversation(ctx: Context, signal: AbortSignal, source: AsyncIterable<ChatGptSignInAnswer>): ChatGptController {
  const invocation: RemoteInvocation = {
    request: { namespace: 'chatgpt', method: 'signIn', args: {} }, service: 'chatGptController',
    peer: { id: 'test' as PeerId, ctx, async dispose() {} }, signal,
    uplink<In>() { return source as AsyncIterable<In> },
  }
  return ctx.extend({ invocation }).get('chatGptController') as ChatGptController
}

function inputChannel() {
  const answer = Promise.withResolvers<ChatGptSignInAnswer>()
  const closed = Promise.withResolvers<undefined>()
  cleanups.push(async () => { answer.resolve({ question: 0, answer: '' }); closed.resolve(undefined) })
  return { answer, source: { async *[Symbol.asyncIterator]() { yield await answer.promise; await closed.promise } } }
}

it.each([new Error('private issuer diagnostics'), 'private rejection'])('redacts a failed authorization', async (failure) => {
  const { ctx } = await fixture(false)
  vi.spyOn(ctx.authorization, 'begin').mockRejectedValue(failure)
  const input = inputChannel()
  const remote = conversation(ctx, new AbortController().signal, input.source)
  const events = []
  for await (const event of remote.signIn(new AbortController().signal)) events.push(event)
  expect(events).toEqual([{ type: 'complete', status: 'failed' }])
})

it('withdraws the current question when its initiating stream closes', async () => {
  const { ctx } = await fixture(false)
  const lifetime = new AbortController()
  const input = inputChannel()
  ctx.authorization.registerFlow({ key: recordKeyFor('openai-codex'), label: 'ChatGPT', methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) { await session.prompt({ kind: 'text', message: 'Code' }) },
  })
  const stream = conversation(ctx, lifetime.signal, input.source).signIn(lifetime.signal)
  const iterator = stream[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toMatchObject({ type: 'prompt', question: 1 })
  lifetime.abort()
  input.answer.resolve({ question: 1, answer: 'late answer' })
  const events = []
  for await (const event of stream) events.push(event)
  expect(events).toContainEqual({ type: 'complete', status: 'cancelled' })
  expect(ctx.authorization.describe(recordKeyFor('openai-codex'))?.inFlight).toBe(false)
  expect(await ctx.credentials.readRecord(recordKeyFor('openai-codex'))).toBeUndefined()
})

it('withdraws a losing manual question while a browser callback commits the login', async () => {
  const { ctx } = await fixture(false)
  const question = new AbortController()
  const input = inputChannel()
  const withdrawn = Promise.withResolvers<undefined>()
  ctx.authorization.registerFlow({ key: recordKeyFor('openai-codex'), label: 'ChatGPT', methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) {
      session.notify({ message: 'progress' })
      session.notify({ message: 'browser', url: 'https://example.test/', code: '1234' })
      try { await session.prompt({ kind: 'text', message: 'Manual callback', signal: question.signal }) } catch (_error) {
        // The browser callback wins this question.
        withdrawn.resolve(undefined)
      }
      await session.commit({ kind: 'grant', payload: { type: 'oauth', access: 'test', refresh: 'test', expires: 1 } })
    },
  })
  const stream = conversation(ctx, new AbortController().signal, input.source).signIn(new AbortController().signal)
  const iterator = stream[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toMatchObject({ type: 'browser', code: '1234' })
  expect((await iterator.next()).value).toMatchObject({ type: 'prompt' })
  question.abort()
  await withdrawn.promise
  const events = []
  for await (const event of stream) events.push(event)
  expect(events).toContainEqual({ type: 'complete', status: 'authorized' })
})

it('answers a selection on its own stream and keeps provider labels', async () => {
  const { ctx } = await fixture(false)
  const input = inputChannel()
  ctx.authorization.registerFlow({ key: recordKeyFor('openai-codex'), label: 'ChatGPT', methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) {
      expect(await session.prompt({ kind: 'select', message: 'Choose', options: [{ id: 'personal', label: 'Personal' }] })).toBe('personal')
      await session.commit({ kind: 'grant', payload: { type: 'oauth', access: 'test', refresh: 'test', expires: 1 } })
    },
  })
  const stream = conversation(ctx, new AbortController().signal, input.source).signIn(new AbortController().signal)
  const iterator = stream[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toMatchObject({ type: 'prompt', kind: 'select', options: [{ id: 'personal', label: 'Personal' }] })
  input.answer.resolve({ question: 1, answer: 'personal' })
  const events = []
  for await (const event of stream) events.push(event)
  expect(events.at(-1)).toEqual({ type: 'complete', status: 'authorized' })
})

it('does not start authorization when the ChatGPT grant already exists', async () => {
  const { controller, ctx } = await fixture()
  const begin = vi.spyOn(ctx.authorization, 'begin')
  const events = []
  for await (const event of controller.signIn(new AbortController().signal)) events.push(event)
  expect(events).toEqual([{ type: 'complete', status: 'authorized' }])
  expect(begin).not.toHaveBeenCalled()
})

it.each(['https://example.test/authorize', 'javascript:private-value', 'not a URL', 'https://user:secret@example.test/'])('projects authorization safely for %s', async (url) => {
  const { ctx } = await fixture(false)
  const lifetime = new AbortController()
  const answer = Promise.withResolvers<ChatGptSignInAnswer>()
  const closed = Promise.withResolvers<undefined>()
  const uplink = { async *[Symbol.asyncIterator]() { yield await answer.promise; await closed.promise } }
  const invocation: RemoteInvocation = {
    request: { namespace: 'chatgpt', method: 'signIn', args: {} }, service: 'chatGptController',
    peer: { id: 'test' as PeerId, ctx, async dispose() {} }, signal: lifetime.signal,
    uplink<In>() { return uplink as AsyncIterable<In> },
  }
  ctx.authorization.registerFlow({ key: recordKeyFor('openai-codex'), label: 'ChatGPT', methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) {
      session.notify({ message: 'private issuer diagnostic', url })
      const response = await session.prompt({ kind: 'secret', message: 'private question' })
      expect(response).toBe('manual-code')
      await session.commit({ kind: 'grant', payload: { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: 1 } })
    },
  })
  const remote = ctx.extend({ invocation }).get('chatGptController') as ChatGptController
  const events = []
  for await (const event of remote.signIn(lifetime.signal)) {
    events.push(event)
    if (event.type === 'prompt') answer.resolve({ question: event.question, answer: 'manual-code' })
  }
  closed.resolve(undefined); answer.resolve({ question: 0, answer: '' })
  const allowed = url === 'https://example.test/authorize'
  expect(events.at(-1)).toEqual({ type: 'complete', status: allowed ? 'authorized' : 'failed' })
  expect(JSON.stringify(events)).not.toContain('private')
  if (!allowed) expect(await credentialStoreFrom(ctx).read('openai-codex')).toBeUndefined()
})

it('removes only the ChatGPT grant on sign-out', async () => {
  const { controller, store } = await fixture()
  await store.modify('deepseek', async () => ({ type: 'api_key', key: 'preserved' }))
  await controller.signOut()
  expect(await store.read('openai-codex')).toBeUndefined()
  expect(await store.read('deepseek')).toEqual({ type: 'api_key', key: 'preserved' })
})

it('waits for an admitted authorization commit before deleting the ChatGPT grant', async () => {
  const { controller, ctx } = await fixture(false)
  const started = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const original = ctx.credentials.modifyRecord.bind(ctx.credentials)
  vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
    started.resolve(undefined); await resume.promise; return original(key, mutate)
  })
  ctx.authorization.registerFlow({ key: recordKeyFor('openai-codex'), label: 'ChatGPT', methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) { await session.commit({ kind: 'grant', payload: { type: 'oauth', access: 'test', refresh: 'test', expires: 1 } }) },
  })
  const authorization = ctx.authorization.begin({ key: recordKeyFor('openai-codex'), method: 'oauth', interaction: {
    notify() {}, async prompt() { return '' },
  } })
  await started.promise
  const removed = controller.signOut()
  const duplicate = controller.signOut()
  ctx.emit('authorization/settled', recordKeyFor('deepseek'), 'cancelled')
  resume.resolve(undefined)
  await Promise.all([authorization, removed, duplicate])
  expect(await ctx.credentials.readRecord(recordKeyFor('openai-codex'))).toBeUndefined()
})

it('does not start a login after its carrier was cancelled', async () => {
  const { controller } = await fixture(false)
  const signal = AbortSignal.abort()
  const iterator = controller.signIn(signal)[Symbol.asyncIterator]()
  expect(await iterator.next()).toMatchObject({ value: { type: 'complete', status: 'cancelled' } })
  expect((await iterator.next()).done).toBe(true)
})

it('requires an initiating Remote carrier for a signed-out login', async () => {
  const { controller } = await fixture(false)
  await expect(controller.signIn(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('requires a Remote stream')
})

it.each(['ftp://example.test/', 'https://user:secret@example.test/'])('rejects an unsafe usage endpoint %s', (endpoint) => {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  expect(() => new ChatGptController(ctx, { chatGptUsageEndpoint: endpoint, chatGptTimeoutMs: 1 })).toThrow('credential-free HTTP(S)')
})

it('does not query usage with a token missing account claims', async () => {
  const { controller, store } = await fixture()
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'invalid', refresh: 'secret', expires: Date.now() + 3600000 }))
  vi.stubGlobal('fetch', vi.fn<typeof fetch>())
  expect((await controller.read()).status).toBe('unavailable')
})

it('redacts a non-Error usage rejection', async () => {
  const { controller } = await fixture()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue('private transport diagnostic'))
  expect((await controller.read()).status).toBe('unavailable')
})

it('discards successful usage if another login replaces the access token', async () => {
  const { controller, store } = await fixture()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => {
    await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'changed', refresh: 'secret', expires: 1 }))
    return Response.json({ email: 'old@example.test' })
  }))
  expect((await controller.read()).status).toBe('unavailable')
})

it('reports unavailable when OAuth resolution supplies no bearer', async () => {
  const { controller, ctx } = await fixture()
  const key = recordKeyFor('openai-codex')
  const grant = await ctx.credentials.readRecord(key)
  vi.spyOn(ctx.credentials, 'readRecord').mockResolvedValueOnce(grant).mockResolvedValueOnce(undefined).mockResolvedValue(grant)
  expect((await controller.read()).status).toBe('unavailable')
})

it('preserves null profile, quotas and credit balances and projects secondary quotas', async () => {
  const { controller } = await fixture()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ email: null, plan_type: null,
    rate_limit: { secondary_window: { used_percent: 15 } }, code_review_rate_limit: { primary_window: { used_percent: 1 } },
    additional_rate_limits: null, credits: { unlimited: true, balance: null },
  })))
  expect(await controller.read()).toMatchObject({ status: 'ready', email: null, plan: null,
    quotas: [{ name: 'codex', primary: null, secondary: { usedPercent: 15 } }, { name: 'code-review', primary: { usedPercent: 1 } }],
    credits: { unlimited: true, balance: null },
  })
})

it('uses the same bearer and subscription identity as models and omits private response fields', async () => {
  const { controller, access } = await fixture()
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    user_id: 'private-user', account_id: 'private-id', access_token: 'private-token',
    email: 'user@example.test', plan_type: 'pro',
    rate_limit: { primary_window: { used_percent: 14, limit_window_seconds: 604800, reset_at: 1791580402 }, secondary_window: null },
    additional_rate_limits: [{ limit_name: 'gpt-reserve', rate_limit: { primary_window: { used_percent: 0 } } }],
    credits: { unlimited: false, balance: 12.5 },
  }))
  vi.stubGlobal('fetch', request)
  expect(await controller.read()).toEqual({ status: 'ready', email: 'user@example.test', plan: 'pro', quotas: [
    { name: 'codex', primary: { usedPercent: 14, windowSeconds: 604800, resetsAt: 1791580402 }, secondary: null },
    { name: 'gpt-reserve', primary: { usedPercent: 0, windowSeconds: null, resetsAt: null }, secondary: null },
  ], credits: { unlimited: false, balance: '12.5' } })
  expect(request.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${access}`, 'ChatGPT-Account-Id': 'subscription-account' })
  expect(request.mock.calls[0]?.[1]?.redirect).toBe('error')
})

it('does not issue a usage request when no ChatGPT login is stored', async () => {
  const { controller } = await fixture(false)
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', request)
  expect((await controller.read()).status).toBe('signed-out')
  expect(request).not.toHaveBeenCalled()
})

it.each([Response.json({}, { status: 401 }), Response.json({ rate_limit: { primary_window: { used_percent: '14' } } })])(
  'reports unavailable for rejected or malformed usage without inventing zero allowance', async (response) => {
    const { controller } = await fixture()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response))
    expect(await controller.read()).toEqual({ status: 'unavailable', email: null, plan: null, quotas: [], credits: null })
  },
)

it('discards usage if the login is removed while the request is pending', async () => {
  const { controller, store } = await fixture()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => {
    await store.delete('openai-codex')
    return Response.json({ email: 'former@example.test', plan_type: 'pro' })
  }))
  expect((await controller.read()).status).toBe('signed-out')
})

it.each(['rejected', 'malformed', 'disconnected'] as const)('reports signed-out when a %s quota read finishes after logout', async (failure) => {
  const { controller, store } = await fixture()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => {
    await store.delete('openai-codex')
    if (failure === 'disconnected') throw new Error('private request error')
    return failure === 'rejected' ? Response.json({}, { status: 401 })
      : Response.json({ rate_limit: { primary_window: { used_percent: 'bad' } } })
  }))
  expect((await controller.read()).status).toBe('signed-out')
})

it('preserves unknown allowance instead of interpreting absent fields as zero', async () => {
  const { controller } = await fixture()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ plan_type: 'pro' })))
  expect(await controller.read()).toEqual({ status: 'ready', email: null, plan: 'pro', quotas: [], credits: null })
})

it('rejects reset timestamps that cannot be displayed as a date', async () => {
  const { controller } = await fixture()
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    rate_limit: { primary_window: { used_percent: 14, reset_at: 8640000000001 } },
  })))
  expect((await controller.read()).status).toBe('unavailable')
})
