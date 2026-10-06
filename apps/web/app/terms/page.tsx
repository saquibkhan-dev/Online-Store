import type { Metadata } from "next";
import Link from "next/link";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms & conditions",
  description: `The terms that apply when you create an account and place orders with ${site.company}: ordering, payment, cancellations and liability.`,
  alternates: { canonical: "/terms" }
};

const UPDATED = "4 October 2026";

export default function TermsPage() {
  return (
    <article className="legal">
      <h1>Terms &amp; conditions</h1>
      <p className="muted">Last updated: {UPDATED}</p>
      <p>
        These terms govern your use of {site.name}, operated by {site.company}. By creating an account or placing an order you
        agree to them. Please also read our <Link href="/privacy">privacy policy</Link>.
      </p>

      <h2>1. Your account</h2>
      <p>
        You must provide accurate information and keep your password confidential. You are responsible for activity on your
        account. Tell us immediately at <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a> if you suspect unauthorised use.
        You must be at least 18 years old to place an order.
      </p>

      <h2>2. Products and prices</h2>
      <p>
        Prices are shown in the currency displayed and are the prices that apply when you place your order; the price is
        confirmed at checkout. We make every effort to keep information accurate, but if we discover an obvious pricing or
        listing error we may cancel the affected order and refund any payment you made.
      </p>

      <h2>3. Placing an order</h2>
      <p>
        An order is a request to buy. It is confirmed once stock is reserved and your payment is successfully received. If an
        item is out of stock, or payment fails or is not completed in time, the order is automatically cancelled and any
        reserved stock is released. You can follow the status of every order on your Orders page.
      </p>

      <h2>4. Payment</h2>
      <p>
        Payments are processed by our payment provider; we never see or store your full card details. If we are unable to
        verify a payment amount, we hold the order for review and contact you rather than complete it incorrectly.
      </p>

      <h2>5. Cancellations and refunds</h2>
      <p>
        You can cancel an order yourself while it is still awaiting payment. Once an order is confirmed, contact us at{" "}
        <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a>. Nothing in these terms limits any rights you have under
        applicable consumer-protection law, including any right to return or refund for faulty or misdescribed goods.
      </p>

      <h2>6. Acceptable use</h2>
      <p>
        Do not misuse the service: no attempts to gain unauthorised access, interfere with its operation, scrape it at a
        harmful rate, bypass security or rate limits, or use it for fraud or any unlawful purpose. We may suspend accounts that do.
      </p>

      <h2>7. Availability and changes</h2>
      <p>We aim for a reliable service but cannot guarantee uninterrupted availability. We may change or discontinue features, and update these terms; the date above shows the latest version.</p>

      <h2>8. Liability</h2>
      <p>
        To the extent permitted by law, we are not liable for indirect or consequential loss, and our total liability for any
        claim relating to an order is limited to the amount you paid for that order. Nothing excludes liability that cannot be
        excluded by law, such as for fraud or death or personal injury caused by negligence.
      </p>

      <h2>9. Governing law</h2>
      <p>These terms are governed by the laws of {site.governingLaw}, and the courts of {site.governingLaw} have jurisdiction, without affecting any mandatory consumer rights in your country.</p>

      <h2>10. Contact</h2>
      <p>{site.company} — <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a></p>
    </article>
  );
}
