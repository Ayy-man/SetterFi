"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { OFFER_CADENCE_PURPOSE_LABELS, OFFER_CADENCE_SENDING_PURPOSES } from "@/lib/offer/types";
import type { MessagingChannel } from "@/lib/booking/types";
import type { FollowupCopy } from "@/lib/repositories/followup-copy";

type Channel = { channel: MessagingChannel; channelLabel: string };
type Props = { channels: readonly Channel[]; initialItems: readonly FollowupCopy[] | null; enabled: boolean };
const statusLabel: Record<FollowupCopy["status"], string> = {
  draft: "Draft", submitted: "Pending approval", approved: "Approved", rejected: "Rejected",
};

function key(channel: MessagingChannel, purpose: string) { return `${channel}:${purpose}`; }

export function FollowupCopyAuthoring({ channels, initialItems, enabled }: Props) {
  const [items, setItems] = useState<readonly FollowupCopy[]>(initialItems ?? []);
  const [bodies, setBodies] = useState<Record<string, string>>(() => Object.fromEntries((initialItems ?? []).map((item) => [key(item.channel, item.purpose), item.body])));
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const itemFor = (channel: MessagingChannel, purpose: string) => items.find((item) => item.channel === channel && item.purpose === purpose);

  async function save(channel: MessagingChannel, purpose: string) {
    const itemKey = key(channel, purpose); const body = bodies[itemKey]?.trim() ?? "";
    if (!body) { setMessage("Write the follow-up before saving it."); return; }
    setBusy(`${itemKey}:save`); setMessage(null);
    try {
      const response = await fetch("/api/coach/followup-copy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, purpose, body }) });
      if (!response.ok) throw new Error("FOLLOWUP_COPY_DRAFT_REFUSED");
      const result = await response.json() as { templateId: string; status: "draft" };
      setItems((current) => {
        const prior = itemFor(channel, purpose);
        const next: FollowupCopy = { id: result.templateId, tenantId: prior?.tenantId ?? "", channel, purpose: purpose as FollowupCopy["purpose"], body, status: "draft", rejectionDetail: null, updatedAt: new Date().toISOString() };
        return [...current.filter((item) => item.channel !== channel || item.purpose !== purpose), next];
      });
      setMessage("Draft saved and logged.");
    } catch { setMessage("That draft could not be saved. Nothing changed."); } finally { setBusy(null); }
  }

  async function submit(channel: MessagingChannel, purpose: string) {
    const item = itemFor(channel, purpose);
    if (!item || item.status === "submitted") return;
    setBusy(`${key(channel, purpose)}:submit`); setMessage(null);
    try {
      const response = await fetch("/api/coach/followup-copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateId: item.id }) });
      if (!response.ok) throw new Error("FOLLOWUP_COPY_SUBMIT_REFUSED");
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "submitted" } : entry));
      setMessage("Sent for approval and logged.");
    } catch { setMessage("That copy could not be submitted. Nothing changed."); } finally { setBusy(null); }
  }

  return (
    <section aria-labelledby="followup-copy-heading" className="coach-panel md:col-span-2">
      <div className="coach-panel__head"><div><p className="coach-panel__eyebrow">Yours</p><h2 id="followup-copy-heading">Follow-up copy</h2></div></div>
      <div className="coach-panel__body gap-[18px]">
        <p className="m-0 max-w-[var(--measure-prose)] text-[16px] leading-[1.45] text-[color:var(--body)]">
          Write the exact words for each connected channel. A follow-up stays blocked until this copy is approved.
        </p>
        {!enabled ? <p className="m-0 text-[15px] text-[color:var(--muted)]">Follow-up is not switched on yet, so nothing can be sent.</p> : null}
        {initialItems === null ? <p className="m-0 text-[15px] text-[color:var(--muted)]">Your current follow-up copy could not be read, so it cannot be changed here right now.</p> : null}
        {channels.length === 0 ? <p className="m-0 text-[15px] text-[color:var(--muted)]">Connect a sending channel before writing follow-up copy.</p> : null}
        {channels.map(({ channel, channelLabel }) => (
          <div className="flex flex-col gap-[12px] border-t border-[var(--line-soft)] pt-[18px] first:border-t-0 first:pt-0" key={channel}>
            <h3 className="m-0 text-[17px] font-semibold text-[color:var(--ink)]">{channelLabel}</h3>
            {OFFER_CADENCE_SENDING_PURPOSES.map((purpose) => {
              const item = itemFor(channel, purpose); const itemKey = key(channel, purpose); const pending = busy?.startsWith(`${itemKey}:`) ?? false;
              return <div className="rounded-[12px] border border-[var(--line)] bg-[var(--well)] p-[14px]" key={purpose}>
                <div className="mb-[8px] flex flex-wrap items-center justify-between gap-[8px]"><label className="text-[15px] font-medium text-[color:var(--ink)]" htmlFor={`followup-copy-${itemKey}`}>{OFFER_CADENCE_PURPOSE_LABELS[purpose]}</label><span className="text-[14px] text-[color:var(--muted)]">{item ? statusLabel[item.status] : "Not written"}</span></div>
                <textarea className="min-h-[84px] w-full rounded-[9px] border border-[var(--line)] bg-[var(--surface)] p-[10px] text-[15px] leading-[1.45] text-[color:var(--ink)]" disabled={!enabled || initialItems === null || pending || item?.status === "submitted"} id={`followup-copy-${itemKey}`} maxLength={channel === "sms" ? 160 : 4000} onChange={(event) => setBodies((current) => ({ ...current, [itemKey]: event.currentTarget.value }))} placeholder={channel === "sms" ? "SMS copy, up to 160 characters" : "Write the follow-up copy"} value={bodies[itemKey] ?? ""} />
                <div className="mt-[8px] flex flex-wrap items-center gap-[8px]"><span className="mr-auto text-[14px] text-[color:var(--muted)]">{channel === "sms" ? `${(bodies[itemKey] ?? "").length}/160 characters` : item?.rejectionDetail ? `Rejected: ${item.rejectionDetail}` : ""}</span><Button disabled={!enabled || initialItems === null || pending || item?.status === "submitted"} onClick={() => void save(channel, purpose)} size="sm" type="button" variant="outline">Save draft</Button><Button disabled={!enabled || initialItems === null || pending || !item || item.status === "submitted"} onClick={() => void submit(channel, purpose)} size="sm" type="button">Submit for approval</Button></div>
              </div>;
            })}
          </div>
        ))}
        {message ? <p className="m-0 text-[14px] text-[color:var(--muted)]" role="status">{message}</p> : null}
      </div>
    </section>
  );
}
