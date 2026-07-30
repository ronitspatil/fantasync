import Link from "next/link"

// Sits at the bottom of the scroll container on every page. Deliberately quiet — muted text, one
// hairline rule — so it reads as chrome rather than content. Everything stays on a single row at
// every width; items are nowrap so a label can't break mid-phrase.
//
// Spans its container rather than insetting itself: in the app shell that container already
// starts to the right of the nav rail, and the legal pages have no rail to clear.
export function SiteFooter() {
  return (
    <footer className="border-t border-[#1F1F1F] px-4 py-6 md:px-6">
      <div className="flex items-center justify-between gap-2 whitespace-nowrap text-[10px] text-[#666] sm:gap-4 sm:text-xs">
        <a
          href="https://x.com/fantasynchq"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[#919191] underline-offset-4 transition-colors hover:text-[#a5f3fc] hover:underline"
        >
          FantasyncHQ
        </a>

        <nav className="flex items-center gap-2 sm:gap-4">
          <Link href="/privacy" className="transition-colors hover:text-[#E7E7E7]">
            Privacy Policy
          </Link>
          <span aria-hidden className="text-[#2A2A2A]">
            •
          </span>
          <Link href="/terms" className="transition-colors hover:text-[#E7E7E7]">
            Terms of Service
          </Link>
        </nav>
      </div>
    </footer>
  )
}
