/** Browser authorization and manual callback entry owned by one mounted account card. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatGptSignInEvent, ChatGptSignInAnswer, RemoteStreamHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './index.ts'
import css from './AccountSection.module.css'

/** Safe authorization stream operations. */
export interface ChatGptSignInProps extends PropsLocale<'settings.account'> {
  /** @param signal - card lifetime. @returns the initiating stream. */
  start: (signal: AbortSignal) => RemoteStreamHandle<ChatGptSignInEvent, ChatGptSignInAnswer>
  /** @param status - terminal authorization outcome. */
  finished: (status: 'authorized' | 'cancelled' | 'failed') => void
}

/** @param props - stream owner and localized controls. @returns inline authorization controls. */
export function ChatGptSignIn({ start, finished, t }: ChatGptSignInProps) {
  const callback = useRef(finished)
  callback.current = finished
  const current = useRef<{ controller: AbortController; stream: ReturnType<ChatGptSignInProps['start']> } | undefined>(undefined)
  const [browser, setBrowser] = useState<Extract<ChatGptSignInEvent, { type: 'browser' }>>()
  const [prompt, setPrompt] = useState<Extract<ChatGptSignInEvent, { type: 'prompt' }>>()
  const [answer, setAnswer] = useState('')
  const [submitted, setSubmitted] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let stream: ReturnType<ChatGptSignInProps['start']>
    try { stream = start(controller.signal) } catch (_error) {
      // A disconnected carrier can refuse the stream before iteration starts.
      callback.current('failed')
      return () => { controller.abort() }
    }
    const owner = { controller, stream }
    current.current = owner
    void (async () => {
      try {
        for await (const event of stream) {
          if (controller.signal.aborted) return
          if (event.type === 'browser') {
            setBrowser(event)
            window.open(event.url, '_blank', 'noopener,noreferrer')
          } else if (event.type === 'prompt') {
            setAnswer(''); setSubmitted(false); setPrompt(event)
          } else if (event.type === 'prompt-closed') {
            setPrompt(previous => previous?.question === event.question ? undefined : previous)
            setAnswer('')
          } else {
            callback.current(event.status)
            return
          }
        }
        if (!controller.signal.aborted) callback.current('failed')
      } catch (_error) {
        // Issuer and transport diagnostics stay on the Host.
        if (!controller.signal.aborted) callback.current('failed')
      }
    })()
    return () => { controller.abort(); stream.dispose(); current.current = undefined }
  }, [start])
  return <div className={css.identityCopy}>
    <p className={css.quotaCaption} role="status">{t('chatGptSigningIn')}</p>
    {browser?.code !== undefined && <p className={css.quotaCaption}>{t('chatGptVerificationCode', { code: browser.code })}</p>}
    <div className={css.links}>
      {browser !== undefined && <a className={css.linkButton} href={browser.url} target="_blank" rel="noopener noreferrer">{t('open')}</a>}
      <Button variant="outline" onClick={() => {
        current.current?.controller.abort(); current.current?.stream.dispose(); callback.current('cancelled')
      }}>{t('cancel')}</Button>
    </div>
    {prompt !== undefined && <form className={css.identityCopy} onSubmit={(event) => {
      event.preventDefault()
      const owner = current.current
      if (owner === undefined || owner.controller.signal.aborted || submitted || !answer.trim()) return
      try { owner.stream.send({ question: prompt.question, answer: answer.trim() }) } catch (_error) {
        // Closing the connection can invalidate an answer between render and submit.
        owner.controller.abort(); owner.stream.dispose(); callback.current('failed')
        return
      }
      setAnswer(''); setSubmitted(true)
    }}>
      {prompt.kind === 'select'
        ? <select aria-label={t('chatGptCode')} value={answer} disabled={submitted} onChange={(event) => { setAnswer(event.target.value) }}>
          <option value="">{t('chatGptSelect')}</option>
          {prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        : <Input aria-label={t('chatGptCode')} placeholder={t('chatGptCode')} type={prompt.kind === 'secret' ? 'password' : 'text'}
          autoComplete="off" value={answer} disabled={submitted} onChange={(event) => { setAnswer(event.target.value) }} />}
      <Button variant="outline" type="submit" disabled={submitted || !answer.trim()}>{t('chatGptSubmit')}</Button>
    </form>}
  </div>
}
