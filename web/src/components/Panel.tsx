import type { ReactNode } from 'react';

/**
 * CRT grid panel with dither overlay and a header rule, matching the original theme.
 * `scroll` keeps long content inside the card: it gets a fixed maximum height and its own scrollbar
 * (true = the default height; or pass a Tailwind max-height class such as "max-h-[300px]").
 */
export function Panel({ title, right, children, className = '', bodyClass = '', flush = false, scroll }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; flush?: boolean; scroll?: boolean | string }) {
  return (
    <div className={`crt-grid-panel relative overflow-hidden ${className}`}>
      <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
      <div className={`relative z-10 flex flex-col w-full ${bodyClass}`}>
        {title && (
          <h3 className={`font-bold tracking-[0.2em] text-lg uppercase text-crypto-text border-b border-crypto-primary pb-2 flex flex-wrap items-center justify-between gap-2 shrink-0 ${flush ? 'px-4 pt-4 mb-0' : 'mb-3'}`}>
            <span>{title}</span>
            {right}
          </h3>
        )}
        {scroll ? <div className={`crt-scroll ${typeof scroll === 'string' ? scroll : 'max-h-[420px]'}`}>{children}</div> : children}
      </div>
    </div>
  );
}
