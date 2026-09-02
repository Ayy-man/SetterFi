/* SetterFi brand primitives: the client's kit rendered as code.
   The mark is the bolt-in-chat icon; the wordmark is the italic lockup with
   "Fi" in the accent. Both draw from --accent rather than a hardcoded hex:
   the mark used to pin Electric Blue #2f6bff, which stopped being the
   product's accent in the redesign, so every surface that kept the mark was
   shipping a second palette in one icon. */

export function SetterFiMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      fill="none"
      height={size}
      viewBox="0 0 96 96"
      width={size}
    >
      <path
        d="M22 20 h52 a8 8 0 0 1 8 8 v34 a8 8 0 0 1 -8 8 H52 l-14 12 v-12 H22 a8 8 0 0 1 -8-8 V28 a8 8 0 0 1 8-8 Z"
        stroke="var(--accent)"
        strokeLinejoin="round"
        strokeWidth="7"
      />
      <path d="M50 28 40 47 h8 l-4 15 14-21 h-8 l4-13 Z" fill="var(--accent)" />
    </svg>
  );
}

export function SetterFiWordmark({ className }: { className?: string }) {
  return (
    <span
      className={`italic font-bold [letter-spacing:var(--t-title-tr)] [&>b]:font-bold [&>b]:text-[var(--accent)]${className ? ` ${className}` : ""}`}
    >
      Setter<b>Fi</b>
    </span>
  );
}
