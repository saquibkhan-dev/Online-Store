import type { Metadata } from "next";
import Link from "next/link";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: `How ${site.company} collects, uses and protects your personal data, and the choices and rights you have.`,
  alternates: { canonical: "/privacy" }
};

const UPDATED = "4 October 2026";

export default function PrivacyPage() {
  return (
    <article className="legal">
      <h1>Privacy policy</h1>
      <p className="muted">Last updated: {UPDATED}</p>
      <p>
        This policy explains what personal data {site.company} (“we”, “us”) collects when you use {site.name}, why we
        collect it, who we share it with and what rights you have. Questions? Email <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account details:</strong> your name, email address and a securely hashed password (we never store your password in readable form).</li>
        <li><strong>Order details:</strong> the items you order, prices, totals, order status and dates.</li>
        <li><strong>Payment status:</strong> whether a payment succeeded or failed, its amount and the reference from our payment provider. We do not receive or store your card number.</li>
        <li><strong>Notifications:</strong> messages we show you about your orders.</li>
        <li><strong>Technical data:</strong> your IP address and request details, used briefly to keep the service secure (for example rate limiting and abuse prevention) and recorded in security logs.</li>
        {site.analyticsDomain && <li><strong>Usage analytics (only if you accept):</strong> anonymous page-view statistics from a privacy-friendly analytics service. See “Cookies” below.</li>}
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>To create and secure your account and sign you in.</li>
        <li>To process, track and support your orders (contract).</li>
        <li>To prevent fraud, abuse and attacks, and to keep the service reliable (legitimate interests).</li>
        <li>To meet legal obligations such as tax and accounting records.</li>
        {site.analyticsDomain && <li>To understand and improve how the site is used (consent, which you can withdraw at any time).</li>}
      </ul>
      <p>We do not sell your personal data and we do not use it for advertising.</p>

      <h2>Cookies</h2>
      <ul>
        <li><strong>Essential — <code>access_token</code>, <code>refresh_token</code>:</strong> keep you signed in. They are secure, HTTP-only cookies and are removed when you sign out. They do not need consent because the site cannot work without them.</li>
        <li><strong>Preference — <code>cookie_consent</code>:</strong> remembers your cookie choice for 6 months.</li>
        {site.analyticsDomain
          ? <li><strong>Analytics (optional):</strong> loaded only after you choose “Accept analytics”. You can change your mind at any time using “Cookie settings” in the page footer.</li>
          : <li>We do not use advertising or tracking cookies.</li>}
      </ul>

      <h2>Who we share it with</h2>
      <p>
        Only service providers that help us run the shop (hosting, our payment provider{site.analyticsDomain ? " and our analytics provider" : ""}), under
        agreements that limit their use of your data, and authorities when the law requires it.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Account data: until you ask us to delete your account.</li>
        <li>Sign-in sessions: up to 30 days, then deleted.</li>
        <li>Order and payment records: as long as the law requires us to keep financial records.</li>
        <li>Security logs: a limited period, then deleted.</li>
      </ul>

      <h2>How we protect it</h2>
      <p>
        Connections are encrypted (HTTPS), passwords are hashed, sign-in tokens are stored in protected cookies, access to
        data is limited by role, and our systems rate-limit and monitor for abuse. No system is perfectly secure; if a
        breach affects you we will notify you and the relevant authorities as the law requires.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask us to access, correct, export or delete your personal data, to restrict or object to certain processing,
        and to withdraw consent. Email <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a> and we will respond within a
        reasonable time (and within the period required by applicable law). You may also complain to your data-protection authority.
      </p>

      <h2>Children</h2>
      <p>The shop is not intended for children under 18 and we do not knowingly collect their data.</p>

      <h2>Changes</h2>
      <p>If we change this policy in a meaningful way we will update the date above and, where appropriate, tell you. See also our <Link href="/terms">terms &amp; conditions</Link>.</p>
    </article>
  );
}
