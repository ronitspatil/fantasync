import type { Metadata } from 'next'
import { Space_Grotesk } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"] });

// Derive the absolute origin for link-preview assets from the deploy env when available (Vercel
// provides VERCEL_PROJECT_PRODUCTION_URL). Falls back to a relative base; the apple-touch-icon still
// drives the messaging-app preview icon either way.
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined)

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: 'Fantasync',
  description: 'NFL fantasy football platform powered by Sleeper',
  applicationName: 'Fantasync',
  icons: {
    icon: [
      {
        url: '/icon.svg?v=3',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png?v=2',
  },
  openGraph: {
    title: 'Fantasync',
    description: 'NFL fantasy football platform powered by Sleeper',
    siteName: 'Fantasync',
    type: 'website',
    images: [
      {
        url: '/social-preview.png?v=1',
        width: 1200,
        height: 630,
        alt: 'Fantasync',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: 'Fantasync',
    description: 'NFL fantasy football platform powered by Sleeper',
    images: ['/social-preview.png?v=1'],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.className} antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
