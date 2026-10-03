/** Account Remote values contain no credential payloads. */
export type { AccountBonusBatch, AccountBonusNotification, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountProfile, AccountUserId, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'

/** One subscription usage window returned by ChatGPT. Missing values remain null. */
export interface ChatGptQuotaWindow {
  /** Percentage consumed, including reported values above 100 when applicable. */
  readonly usedPercent: number
  /** Usage window duration in seconds, or null when the issuer omits it. */
  readonly windowSeconds: number | null
  /** Reset time as Unix seconds, or null when the issuer omits it. */
  readonly resetsAt: number | null
}

/** A named subscription allowance with up to two usage windows. */
export interface ChatGptQuota {
  readonly name: string
  readonly primary: ChatGptQuotaWindow | null
  readonly secondary: ChatGptQuotaWindow | null
}

/** Safe account data; OAuth credentials and issuer account identifiers stay on the Host. */
export interface ChatGptAccountView {
  readonly status: 'signed-out' | 'ready' | 'unavailable'
  readonly email: string | null
  readonly plan: string | null
  readonly quotas: readonly ChatGptQuota[]
  readonly credits: { readonly unlimited: boolean; readonly balance: string | null } | null
}

/** One browser-owned ChatGPT login conversation; OAuth secrets never enter its events. */
export type ChatGptSignInEvent =
  | { readonly type: 'browser'; readonly url: string; readonly code?: string }
  | { readonly type: 'prompt'; readonly question: number; readonly kind: 'text' | 'secret' | 'select'; readonly options: readonly { readonly id: string; readonly label: string }[] }
  | { readonly type: 'prompt-closed'; readonly question: number }
  | { readonly type: 'complete'; readonly status: 'authorized' | 'cancelled' | 'failed' }

/** An answer to a question on the same initiating Remote stream. */
export interface ChatGptSignInAnswer {
  /** Ordinal of the outstanding question; stale ordinals are ignored. */
  readonly question: number
  /** User-entered code, redirect URL or selected option; never logged or persisted by the controller. */
  readonly answer: string
}
