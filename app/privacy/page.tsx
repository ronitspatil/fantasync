import type { Metadata } from "next"
import { Bullets, LegalShell, Section } from "@/components/legal-shell"

export const metadata: Metadata = {
  title: "Privacy Policy · Fantasync",
  description: "What Fantasync stores, what it doesn't, and who it talks to.",
}

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="July 29, 2026">
      <Section heading="The short version">
        <p>
          Fantasync has no accounts and no sign-up. It does not store your league, your roster, or
          anything else about you on its servers. The data it does keep is public NFL statistics,
          which are the same for every visitor.
        </p>
      </Section>

      <Section heading="What we collect">
        <p>
          <strong>When you sync a league.</strong> You give Fantasync a Sleeper username, or connect
          an ESPN or Yahoo account. Fantasync uses that to read your leagues, rosters, and matchups
          from the platform you chose. This information is fetched when you load a page and used to
          render it — it is not written to our database.
        </p>
        <p>
          <strong>Where it lives.</strong> Your selected league and team are saved in your browser's
          local storage so the app remembers them on your next visit. That data never leaves your
          device except as part of a request you trigger.
        </p>
        <p>
          <strong>Platform credentials.</strong> If you connect a private ESPN league or a Yahoo
          account, the associated tokens are stored in cookies that are marked HttpOnly and
          same-site, meaning JavaScript on the page cannot read them. They are sent only to the
          platform they belong to, in order to answer requests you make. They are not logged, not
          shared, and not stored in our database.
        </p>
        <p>
          <strong>Analytics.</strong> The site uses Vercel Web Analytics, which records aggregate
          page views and performance timings. It does not set tracking cookies, does not build a
          profile of you, and does not follow you to other sites.
        </p>
        <p>
          <strong>Server logs.</strong> Like any website, our host records ordinary request logs
          (IP address, timestamp, path, user agent) for a limited period. These are used for
          operating and securing the service — for example, to rate-limit abusive traffic.
        </p>
      </Section>

      <Section heading="What we don't collect">
        <Bullets
          items={[
            "No accounts, passwords, or email addresses.",
            "No payment information — Fantasync is free and has no payment processing.",
            "No advertising or cross-site tracking, and no third-party ad networks.",
            "No sale or rental of any data to anyone, ever.",
            "No use of your league data to train machine-learning models.",
          ]}
        />
      </Section>

      <Section heading="Who we share data with">
        <p>
          Fantasync talks to a small number of services in order to work. It does not send them
          anything beyond what is needed for the request at hand.
        </p>
        <Bullets
          items={[
            <>
              <strong>Sleeper, ESPN, and Yahoo</strong> — to read the league you asked us to sync.
              Their handling of your data is governed by their own privacy policies.
            </>,
            <>
              <strong>Vercel</strong> — hosting and analytics.
            </>,
            <>
              <strong>Supabase</strong> — the database holding NFL statistics, projections, and
              rankings. It contains no information about you.
            </>,
            <>
              <strong>nflverse and DynastyProcess</strong> — public sources for NFL statistics and
              player identifiers. These are read-only; nothing is sent to them.
            </>,
          ]}
        />
        <p>
          The player recommendations, grades, and trade analysis are computed by our own code from
          those statistics. Your roster is not sent to any AI provider.
        </p>
      </Section>

      <Section heading="Deleting your data">
        <p>
          Press <strong>Unsync</strong> in the app. That clears the league stored in your browser and
          the platform cookies described above. Because nothing about you is stored on our servers,
          there is nothing further for us to delete. You can also clear site data through your
          browser's settings at any time.
        </p>
        <p>
          To revoke Fantasync's access on the platform side, use ESPN's or Yahoo's own account
          settings.
        </p>
      </Section>

      <Section heading="Security">
        <p>
          Traffic is served over HTTPS. Platform credentials are held in HttpOnly, same-site cookies
          rather than in local storage, and the site sets a content security policy and related
          headers to limit what a page is permitted to do. No system is perfectly secure, and we
          make no guarantee that it is — but we treat a credential leak as the failure that matters
          most and design around it.
        </p>
      </Section>

      <Section heading="Children">
        <p>
          Fantasync is not directed at children under 13, and we do not knowingly collect personal
          information from them.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          If this policy changes materially, the date at the top of this page will change with it.
          Continuing to use Fantasync after that means you accept the updated policy.
        </p>
      </Section>
    </LegalShell>
  )
}
