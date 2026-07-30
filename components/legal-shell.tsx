import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { SiteFooter } from "@/components/site-footer"

// Shared chrome for /privacy and /terms. These are ordinary documents, so they get a plain
// scrolling page rather than the app shell's fixed-height panel layout.
export function LegalShell({
  title,
  updated,
  children,
}: {
  title: string
  updated: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col bg-black text-white">
      <header className="flex items-center px-4 py-4 md:p-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm text-[#919191] transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 md:px-6 md:py-12">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-[#666]">Last updated {updated}</p>
        <div className="mt-10 flex flex-col gap-8">{children}</div>
      </main>

      <SiteFooter />
    </div>
  )
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight text-white">{heading}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-[#919191] [&_a]:text-[#a5f3fc] [&_a]:underline-offset-4 hover:[&_a]:underline [&_strong]:font-medium [&_strong]:text-[#E7E7E7]">
        {children}
      </div>
    </section>
  )
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-[#4A4A4A]">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}
