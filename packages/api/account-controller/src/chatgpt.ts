/** ChatGPT subscription account reads over the same OAuth store used by model requests. */
import { Context } from '@deepseek-ai/cordis'
import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-authorization'
import { Remote, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { ChatGptAccountView, ChatGptQuota, ChatGptQuotaWindow, ChatGptSignInEvent, ChatGptSignInAnswer } from './types.ts'

/** Deployment policy for authenticated ChatGPT usage queries. */
export interface ChatGptConfig {
  /** ChatGPT usage URL; defaults to the endpoint used by the official Codex client. */
  readonly chatGptUsageEndpoint?: string
  /** Authentication and usage request deadline in milliseconds; defaults to 20000. */
  readonly chatGptTimeoutMs?: number
}

const windowSchema = z.object({
  used_percent: z.number().min(0),
  limit_window_seconds: z.number().int().positive().nullish(),
  reset_at: z.number().int().nonnegative().max(8640000000000).nullish(),
})
const limitsSchema = z.object({
  primary_window: windowSchema.nullish(),
  secondary_window: windowSchema.nullish(),
})
const usageSchema = z.object({
  email: z.string().nullish(),
  plan_type: z.string().nullish(),
  rate_limit: limitsSchema.nullish(),
  code_review_rate_limit: limitsSchema.nullish(),
  additional_rate_limits: z.array(z.object({ limit_name: z.string(), rate_limit: limitsSchema.nullish() })).nullish(),
  credits: z.object({ unlimited: z.boolean(), balance: z.union([z.string(), z.number()]).nullish() }).nullish(),
})
const identitySchema = z.object({ 'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().min(1) }) })

function accountView(status: ChatGptAccountView['status']): ChatGptAccountView {
  return { status, email: null, plan: null, quotas: [], credits: null }
}

function projectWindow(value: z.infer<typeof windowSchema> | null | undefined): ChatGptQuotaWindow | null {
  return value === null || value === undefined ? null : {
    usedPercent: value.used_percent,
    windowSeconds: value.limit_window_seconds ?? null,
    resetsAt: value.reset_at ?? null,
  }
}

function projectQuota(name: string, value: z.infer<typeof limitsSchema> | null | undefined): ChatGptQuota {
  return { name, primary: projectWindow(value?.primary_window), secondary: projectWindow(value?.secondary_window) }
}

function accountIdOf(access: string): string {
  const encoded = access.split('.')[1]
  if (encoded === undefined) throw new Error('ChatGPT access token contains no claims')
  const claims: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  return identitySchema.parse(claims)['https://api.openai.com/auth'].chatgpt_account_id
}

/** Host owner of safe ChatGPT account and allowance reads. */
export class ChatGptController extends TypertRemoteService {
  static inject = ['credentials', 'authorization']
  private readonly activity: { signOut: Promise<void> | undefined } = { signOut: undefined }
  private readonly endpoint: string
  private readonly timeoutMs: number

  /** @param ctx - Host credential context. @param config - resolved endpoint and request deadline. */
  constructor(ctx: Context, config: Required<ChatGptConfig>) {
    super(ctx, 'chatGptController', { namespace: 'chatgpt' })
    const endpoint = new URL(config.chatGptUsageEndpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('ChatGPT usage endpoint must be a credential-free HTTP(S) URL')
    }
    this.endpoint = endpoint.href
    this.timeoutMs = config.chatGptTimeoutMs
  }

  /**
   * Query the signed-in subscription after refreshing OAuth through the shared credential store.
   * @returns sanitized profile and quota windows, or an explicit signed-out/unavailable state.
   */
  @Remote
  async read(): Promise<ChatGptAccountView> {
    const store = credentialStoreFrom(this.ctx)
    if ((await store.read('openai-codex'))?.type !== 'oauth') return accountView('signed-out')
    const unavailable = async (): Promise<ChatGptAccountView> =>
      accountView((await store.read('openai-codex'))?.type === 'oauth' ? 'unavailable' : 'signed-out')
    try {
      const signal = AbortSignal.timeout(this.timeoutMs)
      const models = createModels({ credentials: store, authContext: authContextFrom(this.ctx) })
      models.setProvider(openaiCodexProvider())
      const access = (await models.getAuth('openai-codex', { signal }))?.auth.apiKey
      if (access === undefined) return await unavailable()
      const response = await fetch(this.endpoint, { signal, redirect: 'error', headers: {
        Authorization: `Bearer ${access}`, 'ChatGPT-Account-Id': accountIdOf(access),
      } })
      if (!response.ok) return await unavailable()
      const payload: unknown = await response.json()
      const parsed = usageSchema.safeParse(payload)
      if (!parsed.success) return await unavailable()
      const current = await store.read('openai-codex')
      if (current?.type !== 'oauth') return accountView('signed-out')
      if (current.access !== access) return accountView('unavailable')
      const value = parsed.data
      const quotas = [projectQuota('codex', value.rate_limit), projectQuota('code-review', value.code_review_rate_limit),
        ...value.additional_rate_limits?.map(limit => projectQuota(limit.limit_name, limit.rate_limit)) ?? []]
        .filter(limit => limit.primary !== null || limit.secondary !== null)
      return { status: 'ready', email: value.email ?? null, plan: value.plan_type ?? null, quotas,
        credits: value.credits === null || value.credits === undefined ? null : {
          unlimited: value.credits.unlimited, balance: value.credits.balance === null || value.credits.balance === undefined
            ? null : String(value.credits.balance),
        } }
    } catch (error) {
      // Provider errors can carry request credentials; only the category is logged.
      this.ctx.logger.warn('ChatGPT account query failed (%s)', error instanceof Error ? error.name : 'unknown')
      return await unavailable()
    }
  }

  /**
   * Run the existing Codex OAuth flow, scoped to the initiating browser stream.
   * @param signal - closing this stream withdraws its login and outstanding questions.
   * @returns safe browser links, questions and one terminal status; failures reveal no issuer diagnostics.
   */
  @Remote({ mode: 'stream' })
  async *signIn(signal: AbortSignal): RemoteStream<ChatGptSignInEvent, ChatGptSignInAnswer> {
    await this.activity.signOut
    const stored = await credentialStoreFrom(this.ctx).read('openai-codex')
    if (signal.aborted || this.activity.signOut !== undefined) {
      yield { type: 'complete', status: 'cancelled' }
      return
    }
    if (stored?.type === 'oauth') {
      yield { type: 'complete', status: 'authorized' }
      return
    }
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('ChatGPT sign-in requires a Remote stream')
    const lifetime = new AbortController()
    const abort = (): void => { lifetime.abort() }
    signal.addEventListener('abort', abort, { once: true })
    const pending: ChatGptSignInEvent[] = []
    const questions = new Map<number, { resolve: (answer: string) => void; reject: (error: Error) => void }>()
    const state = { finished: false, invalidUrl: false, question: 0, wake: undefined as (() => void) | undefined }
    const publish = (event: ChatGptSignInEvent): void => { pending.push(event); state.wake?.() }
    const rejectQuestions = (): void => {
      for (const question of questions.values()) question.reject(new DOMException('Login cancelled', 'AbortError'))
      questions.clear()
    }
    lifetime.signal.addEventListener('abort', rejectQuestions, { once: true })
    const answers = (async () => {
      try {
        for await (const item of invocation.uplink<ChatGptSignInAnswer>()) {
          if (lifetime.signal.aborted) return
          questions.get(item.question)?.resolve(item.answer)
        }
      } catch (_error) {
        // Invalid or disconnected uplinks withdraw only their own conversation.
      } finally { lifetime.abort() }
    })()
    const run = (async () => {
      try {
        const outcome = await this.ctx.authorization.begin({ key: recordKeyFor('openai-codex'), method: 'oauth', signal: lifetime.signal,
          interaction: {
            notify: (notice) => {
              if (lifetime.signal.aborted || notice.url === undefined) return
              let url: URL
              try { url = new URL(notice.url) } catch (_error) {
                // Malformed provider URLs never reach the browser.
                state.invalidUrl = true; lifetime.abort(); return
              }
              if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                state.invalidUrl = true; lifetime.abort(); return
              }
              publish({ type: 'browser', url: url.href, ...notice.code === undefined ? {} : { code: notice.code } })
            },
            prompt: async (prompt) => {
              lifetime.signal.throwIfAborted()
              prompt.signal?.throwIfAborted()
              const question = ++state.question
              const withdrawn = (): void => {
                questions.get(question)?.reject(new DOMException('Question withdrawn', 'AbortError'))
              }
              const answer = new Promise<string>((resolve, reject) => { questions.set(question, { resolve, reject }) })
              prompt.signal?.addEventListener('abort', withdrawn, { once: true })
              publish({ type: 'prompt', question, kind: prompt.kind,
                options: prompt.kind === 'select' ? prompt.options.map(option => ({ id: option.id, label: option.label })) : [] })
              try { return await answer } finally {
                prompt.signal?.removeEventListener('abort', withdrawn)
                questions.delete(question)
                publish({ type: 'prompt-closed', question })
              }
            },
          },
        })
        publish({ type: 'complete', status: state.invalidUrl ? 'failed' : outcome.status })
      } catch (error) {
        this.ctx.logger.warn('ChatGPT sign-in failed (%s)', error instanceof Error ? error.name : 'unknown')
        publish({ type: 'complete', status: 'failed' })
      } finally {
        state.finished = true
        rejectQuestions()
        state.wake?.()
      }
    })()
    try {
      while (!state.finished || pending.length > 0) {
        const event = pending.shift()
        if (event !== undefined) yield event
        else await new Promise<void>((resolve) => { state.wake = resolve })
      }
    } finally {
      lifetime.abort()
      signal.removeEventListener('abort', abort)
      await run
      // The carrier returns its uplink when this method completes; never await that return here.
      void answers
    }
  }

  /**
   * Remove the local ChatGPT login after any admitted login commit settles.
   * @returns after deletion; model configurations and DeepSeek login remain available.
   */
  @Remote
  async signOut(): Promise<void> {
    if (this.activity.signOut !== undefined) return this.activity.signOut
    const key = recordKeyFor('openai-codex')
    const remove = (async () => {
      if (this.ctx.authorization.describe(key)?.inFlight === true) {
        let stop: (() => void) | undefined
        try {
          await new Promise<void>((resolve) => {
            stop = this.ctx.on('authorization/settled', (settledKey) => { if (settledKey === key) resolve() })
            this.ctx.authorization.cancel(key)
          })
        } finally { stop?.() }
      }
      await this.ctx.credentials.deleteRecord(key)
    })()
    this.activity.signOut = remove
    try { await remove } finally { this.activity.signOut = undefined }
  }
}
