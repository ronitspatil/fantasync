import { NextResponse, type NextRequest } from "next/server"

// Security headers for every response.
//
// These are the browser-side half of the story: the route handlers decide who may do what, and
// these decide what a browser will let a page do if something slips past. Cheap, and several of
// them close holes that no amount of server-side checking can.

export function middleware(req: NextRequest) {
  const res = NextResponse.next()
  const isAdmin = req.nextUrl.pathname.startsWith("/admin")

  // Clickjacking. Without this, an attacker frames /admin invisibly over their own page and
  // harvests clicks from a logged-in admin — every destructive button on that screen is one click
  // with no confirmation. frame-ancestors is the modern control; X-Frame-Options covers browsers
  // that don't honor it.
  res.headers.set("X-Frame-Options", "DENY")

  // Don't let a browser second-guess a Content-Type. Chiefly stops a response we serve as data
  // from being sniffed into something executable.
  res.headers.set("X-Content-Type-Options", "nosniff")

  // Keep paths and query strings out of Referer on cross-origin navigations.
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")

  // Nothing here needs any of these, and denying them means a compromised script can't ask.
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  )

  // HSTS in production only — setting it on a local HTTP origin would pin localhost to https in
  // the developer's browser and be a nuisance to undo.
  if (process.env.NODE_ENV === "production") {
    res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
  }

  res.headers.set("Content-Security-Policy", contentSecurityPolicy())

  // Keep the admin surface out of search results. Not a security control on its own — the auth is
  // what protects it — but there's no reason to advertise the login page.
  if (isAdmin) {
    res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive")
  }

  return res
}

// The policy, with an honest note about its main limitation.
//
// `script-src` has to allow 'unsafe-inline' and 'unsafe-eval': Next injects an inline bootstrap
// script and the dev server needs eval for hot reload. That means this CSP is NOT a meaningful
// defence against injected script — a real one needs per-request nonces threaded through the app.
//
// What it does buy, and what is worth having on its own:
//   frame-ancestors — the clickjacking control above, enforced by modern browsers.
//   base-uri        — stops an injected <base> tag from silently re-pointing every relative URL.
//   form-action     — stops an injected form from posting the page's data to another origin.
//   connect-src     — bounds where fetch/XHR can send data, so exfiltration has nowhere to go.
//   object-src      — kills the legacy plugin vector outright.
function contentSecurityPolicy(): string {
  const dev = process.env.NODE_ENV !== "production"
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    // Tailwind and Next both inject style tags at runtime.
    "style-src 'self' 'unsafe-inline'",
    // Sleeper serves player headshots and team logos.
    "img-src 'self' data: blob: https://sleepercdn.com",
    "font-src 'self' data:",
    // The APIs this app actually talks to from the browser. Anything else is exfiltration.
    `connect-src 'self' https://api.sleeper.app https://*.supabase.co${dev ? " ws: http://localhost:*" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ")
}

export const config = {
  // Everything except Next's own static output and the favicon — those are served straight from
  // the CDN and carry no user data.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
