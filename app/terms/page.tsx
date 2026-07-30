import type { Metadata } from "next"
import { Bullets, LegalShell, Section } from "@/components/legal-shell"

export const metadata: Metadata = {
  title: "Terms of Service · Fantasync",
  description: "The terms you agree to by using Fantasync.",
}

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="July 29, 2026">
      <Section heading="Agreement">
        <p>
          By using Fantasync you agree to these terms. If you do not agree with them, please do not
          use the site. Fantasync is a free, personal project provided as a convenience — there is
          no subscription, no contract, and no service-level commitment.
        </p>
      </Section>

      <Section heading="Not affiliated">
        <p>
          Fantasync is an independent tool. It is <strong>not</strong> affiliated with, endorsed by,
          sponsored by, or in any way officially connected to the National Football League, the
          Sleeper app, ESPN, Yahoo, or any of their subsidiaries or affiliates. All team names,
          player names, and logos are the property of their respective owners.
        </p>
        <p>
          When you sync a league, you remain bound by that platform's own terms of service. You are
          responsible for making sure your use of Fantasync is permitted by them.
        </p>
      </Section>

      <Section heading="Projections are estimates">
        <p>
          Rankings, projections, player grades, trade evaluations, and playoff odds are statistical
          estimates produced by models. They are provided for informational and entertainment
          purposes only. They are frequently wrong, sometimes badly so, and nothing on this site is a
          guarantee of any outcome.
        </p>
        <p>
          Fantasync is not financial, betting, or professional advice. If you use it to inform a
          wager, that decision and its consequences are entirely yours, and you are responsible for
          complying with the laws that apply where you live.
        </p>
      </Section>

      <Section heading="Acceptable use">
        <p>You agree not to:</p>
        <Bullets
          items={[
            "Attempt to gain unauthorized access to any part of the site, its administrative interface, its database, or its infrastructure.",
            "Probe, scan, or test the site's security, or interfere with or disrupt its operation.",
            "Scrape, crawl, or automate requests at a volume that degrades the service for others, or that violates an upstream provider's terms.",
            "Use the site to access a league or account you do not have permission to access.",
            "Reproduce or redistribute the site's data or output in a way that misrepresents its source or accuracy.",
          ]}
        />
        <p>
          We may rate-limit, block, or discontinue access for any traffic that appears to be abusive,
          without notice.
        </p>
      </Section>

      <Section heading="Availability">
        <p>
          Fantasync may change, break, go offline, or be discontinued at any time, with or without
          notice. It depends on third-party data sources that may themselves change or disappear.
          There is no guarantee that data will be current, complete, or accurate, and no obligation
          to preserve anything.
        </p>
      </Section>

      <Section heading="No warranty">
        <p>
          The site is provided <strong>&ldquo;as is&rdquo; and &ldquo;as available,&rdquo;</strong>{" "}
          without warranties of any kind, whether express or implied, including but not limited to
          the implied warranties of merchantability, fitness for a particular purpose,
          non-infringement, and any warranty of accuracy or uninterrupted availability.
        </p>
      </Section>

      <Section heading="Limitation of liability">
        <p>
          To the fullest extent permitted by law, Fantasync and its author will not be liable for any
          indirect, incidental, special, consequential, or punitive damages, or for any loss of data,
          profits, league standings, or fantasy championships, arising out of or in connection with
          your use of the site — whether or not we were advised of the possibility of such damages.
        </p>
      </Section>

      <Section heading="Privacy">
        <p>
          Our handling of data is described in the <a href="/privacy">Privacy Policy</a>, which forms
          part of these terms.
        </p>
      </Section>

      <Section heading="Changes to these terms">
        <p>
          These terms may be updated from time to time. The date at the top of this page reflects the
          most recent revision, and continuing to use Fantasync after a change means you accept it.
        </p>
      </Section>
    </LegalShell>
  )
}
