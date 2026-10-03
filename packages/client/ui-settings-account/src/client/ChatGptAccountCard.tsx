/** ChatGPT subscription usage projected by the authenticated Host. */
import { useEffect, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatGptAccountView, ChatGptQuotaWindow } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './index.ts'
import css from './AccountSection.module.css'
import { ChatGptSignIn, type ChatGptSignInProps } from './ChatGptSignIn.tsx'

/** Account query and localized copy for the subscription card. */
export interface ChatGptAccountCardProps extends PropsLocale<'settings.account'> {
  /** @returns subscription identity and quota windows without OAuth secrets. */
  read: () => Promise<ChatGptAccountView>
  /** Browser authorization owned by this card. */
  signIn?: ChatGptSignInProps['start'] | undefined
  /** @returns after the local ChatGPT grant is removed. */
  signOut?: (() => Promise<void>) | undefined
  /** @param listener - credential change callback. @returns listener cleanup. */
  subscribe?: ((listener: () => void) => () => void) | undefined
}

function windowLabel(window: ChatGptQuotaWindow, t: ChatGptAccountCardProps['t']): string {
  const seconds = window.windowSeconds
  if (seconds === null) return t('chatGptWindow')
  const unit = seconds >= 86400 ? 86400 : seconds >= 3600 ? 3600 : 60
  return t(unit === 86400 ? 'chatGptDays' : unit === 3600 ? 'chatGptHours' : 'chatGptMinutes', { count: String(seconds / unit) })
}

/**
 * Keep the last successful reading while a refresh fails; discard reads after unmount.
 * @param props - Host reader and account dictionary.
 * @returns subscription identity, remaining usage and reset times.
 */
export function ChatGptAccountCard({ read, signIn, signOut, subscribe, t }: ChatGptAccountCardProps) {
  const [view, setView] = useState<ChatGptAccountView>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(true)
  const [revision, setRevision] = useState(0)
  const [signingIn, setSigningIn] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  useEffect(() => subscribe?.(() => { setRevision(value => value + 1) }), [subscribe])
  useEffect(() => {
    const lifetime = new AbortController()
    setBusy(true)
    void (async () => {
      try {
        const next = await read()
        if (lifetime.signal.aborted) return
        setFailed(next.status === 'unavailable')
        setView(previous => next.status === 'unavailable' && previous?.status === 'ready' ? previous : next)
      } catch (_error) {
        // The Host owns diagnostics; the card keeps only safe localized failure copy.
        if (!lifetime.signal.aborted) setFailed(true)
      } finally {
        if (!lifetime.signal.aborted) setBusy(false)
      }
    })()
    return () => { lifetime.abort() }
  }, [read, revision])
  const quotaName = (name: string) => name === 'codex' ? t('chatGptCodex')
    : name === 'code-review' ? t('chatGptCodeReview') : name === 'gpt-reserve' ? t('chatGptReserve') : name
  return <section className={css.balanceCard} aria-label={t('chatGptAccount')}>
    <div className={css.row}>
      <div className={css.identityCopy}>
        <span className={css.name}>{t('chatGptAccount')}</span>
        {view?.status === 'ready' && <>
          {view.email !== null && <span className={css.quotaCaption}>{view.email}</span>}
          {view.plan !== null && <span className={css.quotaCaption}>{t('chatGptPlan', { plan: view.plan })}</span>}
        </>}
      </div>
      <div className={css.links}>
        <Button variant="outline" disabled={busy || signingIn || signingOut} onClick={() => { setRevision(value => value + 1) }}>{t('chatGptRefresh')}</Button>
        {view !== undefined && view.status !== 'signed-out' && signOut !== undefined && <Button variant="outline" disabled={signingOut}
          onClick={() => {
            setSigningOut(true); setActionFailed(false)
            void signOut().then(() => {
              setView({ status: 'signed-out', email: null, plan: null, quotas: [], credits: null })
              setFailed(false); setRevision(value => value + 1)
            }, () => { setActionFailed(true) }).finally(() => { setSigningOut(false) })
          }}>{t(signingOut ? 'chatGptSigningOut' : 'signOut')}</Button>}
        {view?.status === 'signed-out' && signIn !== undefined && !signingIn && <Button variant="outline" onClick={() => {
          setActionFailed(false); setSigningIn(true)
        }}>{t('chatGptSignIn')}</Button>}
      </div>
    </div>
    {actionFailed && <p className={css.quotaCaption} role="status">{t('failed')}</p>}
    {signingIn && signIn !== undefined && <ChatGptSignIn start={signIn} t={t} finished={(status) => {
      setSigningIn(false); setActionFailed(status === 'failed'); setRevision(value => value + 1)
    }} />}
    {busy && view === undefined ? <div className={css.quotaLoading} role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>
      : view?.status === 'ready' ? <>
        {failed && <p className={css.quotaCaption} role="status">{t('chatGptStale')}</p>}
        {view.quotas.length === 0 && <p className={css.quotaCaption}>{t('chatGptNoQuotas')}</p>}
        {view.quotas.map((quota, index) => <div key={`${quota.name}-${index}`} className={css.quotaGroup}>
          <div className={css.divider} />
          {[quota.primary, quota.secondary].map((window, position) => {
            if (window === null) return null
            const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent))
            const label = `${quotaName(quota.name)} · ${windowLabel(window, t)}`
            return <div key={position} className={css.quotaWindow}>
              <div className={css.row}><span>{label}</span><span className={css.quotaAmount}>{t('chatGptRemaining', { percent: String(remaining) })}</span></div>
              <progress className={css.quotaProgress} max={100} value={remaining} aria-label={label} />
              {window.resetsAt !== null && <span className={css.quotaCaption}>{t('chatGptReset', {
                time: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(window.resetsAt * 1000)),
              })}</span>}
            </div>
          })}
        </div>)}
        {view.credits !== null && <><div className={css.divider} /><div className={css.row}>
          <span>{t('chatGptCredits')}</span><span>{view.credits.unlimited ? t('chatGptUnlimited') : view.credits.balance ?? t('chatGptUnknown')}</span>
        </div></>}
      </> : <p className={css.quotaCaption} role="status">{t(view?.status === 'signed-out' ? 'chatGptSignedOut' : 'chatGptUnavailable')}</p>}
  </section>
}
