"use client"

// The one place a research article is turned into markup. The public Research tab and the admin
// console's preview both render this, so what an editor previews is what a reader gets.

// Bodies are authored as Markdown (see lib/research-gemini.ts), but only ever use headings,
// paragraphs and bullets — so this renders those three rather than pulling in a parser.
export function ArticleBody({ body }: { body: string }) {
  return (
    <div className="mt-6 space-y-4 text-sm leading-7 text-[#D0D0D0]">
      {body.split(/\n{2,}/).map((block, index) => {
        const value = block.trim()
        if (!value) return null
        if (value.startsWith("## ")) {
          return (
            <h3 key={index} className="pt-2 text-lg font-semibold text-white">
              {value.slice(3)}
            </h3>
          )
        }
        if (value.startsWith("### ")) {
          return (
            <h4 key={index} className="pt-1 text-sm font-semibold text-white">
              {value.slice(4)}
            </h4>
          )
        }
        const lines = value.split("\n").map((line) => line.trim()).filter(Boolean)
        if (lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line))) {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5 marker:text-[#666]">
              {lines.map((line, i) => (
                <li key={i}>{line.replace(/^[-*]\s+/, "")}</li>
              ))}
            </ul>
          )
        }
        return <p key={index}>{lines.join(" ")}</p>
      })}
    </div>
  )
}

// A full article as a reader sees it. Callers supply their own fallbacks for empty fields — an
// unsaved draft wants "Untitled article" where a published piece always has a real title.
export function ArticleView({
  category,
  title,
  dek,
  author,
  date,
  body,
}: {
  category: string
  title: string
  dek: string
  author: string
  // Omitted for an unsaved draft, which has no publication date yet.
  date?: string | null
  body: string
}) {
  return (
    <article className="mx-auto max-w-3xl">
      <div className="text-[10px] font-bold uppercase tracking-wide text-[#a5f3fc]">{category}</div>
      <h2 className="mt-2 text-2xl font-semibold leading-tight text-white sm:text-3xl">{title}</h2>
      {dek && <p className="mt-3 text-sm leading-6 text-[#B7B7B7]">{dek}</p>}
      <div className="mt-4 border-b border-[#1F1F1F] pb-4 text-xs text-[#919191]">
        {author}
        {date ? ` · ${date}` : ""}
      </div>
      <ArticleBody body={body} />
    </article>
  )
}
