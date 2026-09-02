"use client"

import { Send } from "@/components/kit/icons";

import type { FormEvent, KeyboardEvent, ReactElement } from "react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export type DataStateAction = {
  label: string
  onClick?: () => void
  href?: string
}

export type ComposerProps = {
  disabled?: false | { reason: string; action?: DataStateAction }
  sending: boolean
  placeholder: string
  onSend: (body: string) => Promise<void>
  tabs?: readonly { key: string; label: string }[]
  /** Foot line naming where this send lands. Only state what the data actually says. */
  hint?: string
}

const actionClassName =
  "transition-[transform,opacity] duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:transition-none"

export function Composer({
  disabled = false,
  sending,
  placeholder,
  onSend,
  tabs,
  hint,
}: ComposerProps): ReactElement {
  const [body, setBody] = useState("")
  const trimmedBody = body.trim()

  async function submit(): Promise<void> {
    if (!trimmedBody || sending) return

    const outgoingBody = trimmedBody
    setBody("")

    try {
      await onSend(outgoingBody)
    } catch {
      setBody((current) => current.trim() || outgoingBody)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void submit()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  if (disabled) {
    return (
      <section
        className="sticky bottom-0 z-[var(--z-sticky)] flex min-h-[calc(var(--s-12)+var(--s-12))] items-center justify-between gap-[var(--s-4)] rounded-[var(--r-card)] border border-[var(--line-strong)] bg-[var(--card)] px-[var(--s-4)] py-[var(--s-3)] [padding-bottom:max(var(--s-3),env(safe-area-inset-bottom))]"
        data-slot="composer-gate"
        id="message-composer"
        tabIndex={-1}
      >
        <p className="m-0 text-body text-[color:var(--body)]">{disabled.reason}</p>
        {disabled.action?.href ? (
          <Button
            className={cn(actionClassName)}
            nativeButton={false}
            render={
              <a
                href={disabled.action.href}
                onClick={disabled.action.onClick}
              />
            }
            size="sm"
          >
            {disabled.action.label}
          </Button>
        ) : disabled.action?.onClick ? (
          <Button
            className={actionClassName}
            onClick={disabled.action.onClick}
            size="sm"
            type="button"
          >
            {disabled.action.label}
          </Button>
        ) : null}
      </section>
    )
  }

  return (
    <form
      className="composer sticky bottom-0 z-[var(--z-sticky)] flex-col rounded-[var(--r-card)] border border-[var(--line-strong)] bg-[var(--card)] [padding-bottom:max(var(--s-2),env(safe-area-inset-bottom))] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[color:var(--focus-ring)]"
      data-slot="composer"
      id="message-composer"
      onSubmit={handleSubmit}
      tabIndex={-1}
    >
      {tabs?.length ? (
        <Tabs className="px-[var(--s-3)] pt-[var(--s-2)]" defaultValue={tabs[0].key}>
          <TabsList aria-label="Message type">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.key} value={tab.key}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}

      <label className="sr-only" htmlFor="message-composer-field">
        Message
      </label>
      <Textarea
        aria-busy={sending}
        autoComplete="off"
        className="min-h-[calc(var(--s-12)+var(--s-6))] max-h-[calc(var(--s-12)*3)] resize-none rounded-none border-0 bg-transparent px-[var(--s-3)] py-[calc(var(--s-2)+var(--s-1)/2)] text-[length:var(--t-section)] font-[var(--t-body-w)] leading-[var(--t-body-lh)] text-[color:var(--ink)] shadow-none transition-none placeholder:text-[color:var(--faint)] focus-visible:border-transparent focus-visible:ring-0 sm:text-[length:var(--t-row)] dark:bg-transparent"
        id="message-composer-field"
        onChange={(event) => setBody(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        value={body}
      />

      <div className="flex min-w-0 items-center gap-[var(--s-2)] pb-[var(--s-2)] pl-[var(--s-3)] pr-[var(--s-2)] pt-[var(--s-1)]">
        {hint ? (
          <p className="m-0 min-w-0 flex-1 truncate text-[length:var(--t-badge)] font-[var(--t-body-w)] leading-[var(--t-body-lh)] text-[color:var(--faint)]">
            {hint}
          </p>
        ) : (
          <span className="flex-1" />
        )}
        <Button
          aria-busy={sending}
          className={actionClassName}
          disabled={sending || !trimmedBody}
          size="sm"
          type="submit"
        >
          <Send aria-hidden="true" className="size-[var(--s-4)]" />
          Send
        </Button>
      </div>
    </form>
  )
}
