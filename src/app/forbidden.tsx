export default function ForbiddenPage() {
  return (
    <main className="mx-auto grid w-full max-w-[var(--content-max)] gap-[var(--s-2)] px-[var(--s-4)] py-[var(--s-8)] text-[length:var(--t-body)] text-[var(--body)] sm:px-[var(--s-6)]">
      <h1 className="text-[length:var(--t-title)] font-[var(--t-title-w)] leading-[var(--t-title-lh)] tracking-[var(--t-title-tr)] text-[var(--ink)]">
        Forbidden
      </h1>
      <p className="text-[var(--muted)]">This page is not available for your role.</p>
    </main>
  );
}
