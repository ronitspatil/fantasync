import Link from "next/link"

// Sits at the bottom of the scroll container on every page. Deliberately quiet — muted text, one
// hairline rule — so it reads as chrome rather than content. Everything stays on a single row at
// every width; items are nowrap so a label can't break mid-phrase.
//
// Spans its container rather than insetting itself: in the app shell that container already
// starts to the right of the nav rail, and the legal pages have no rail to clear.
export function SiteFooter() {
  return (
    <footer className="border-t border-[#161616] px-4 py-3 md:px-6">
      <div className="flex items-center justify-between gap-2 whitespace-nowrap text-[10px] text-[#4F4F4F] sm:gap-4">
        {/* Icon-only, so the accessible name has to come from aria-label — the glyph itself is
            decorative and would otherwise read out as the letter "X" alone. Unboxed: a bordered
            chip read as a button and pulled more attention than a footer link should. */}
        <a
          href="https://x.com/fantasyncron"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Fantasync on X"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded font-bold leading-none transition-colors hover:text-[#919191]"
        >
          <span aria-hidden>X</span>
        </a>

        <nav className="flex items-center gap-2 sm:gap-4">
          <Link href="/privacy" className="transition-colors hover:text-[#919191]">
            Privacy Policy
          </Link>
          <span aria-hidden className="text-[#242424]">
            •
          </span>
          <Link href="/terms" className="transition-colors hover:text-[#919191]">
            Terms of Service
          </Link>
        </nav>
      </div>
    </footer>
  )
}
