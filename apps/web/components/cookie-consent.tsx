"use client";
import Link from "next/link";
import Script from "next/script";
import { useCallback, useEffect, useState } from "react";

const COOKIE = "cookie_consent";
type Choice = "accepted" | "declined";

const read = (): Choice | null => {
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=(accepted|declined)`));
  return (match?.[1] as Choice | undefined) ?? null;
};
const write = (choice: Choice) => {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=${choice}; Max-Age=${180 * 86_400}; Path=/; SameSite=Lax${secure}`;
};

/**
 * Consent banner + consent-gated analytics. Analytics code is not even downloaded until the visitor accepts, and the
 * essential cookies (sign-in session) never depend on this choice. Accept and Decline carry equal visual weight.
 */
export function CookieConsent({ analyticsDomain, analyticsSrc, nonce }: { analyticsDomain?: string; analyticsSrc: string; nonce?: string }) {
  const [choice, setChoice] = useState<Choice | null | "loading">("loading");
  const [reopen, setReopen] = useState(false);

  useEffect(() => {
    setChoice(read());
    const open = () => setReopen(true);
    window.addEventListener("open-cookie-settings", open);
    return () => window.removeEventListener("open-cookie-settings", open);
  }, []);

  const decide = useCallback((c: Choice) => {
    write(c);
    setChoice(c);
    setReopen(false);
  }, []);

  const showBanner = choice === null || reopen;
  return (
    <>
      {choice === "accepted" && analyticsDomain && (
        <Script src={analyticsSrc} data-domain={analyticsDomain} strategy="afterInteractive" nonce={nonce} defer />
      )}
      {showBanner && (
        <div role="dialog" aria-modal="false" aria-labelledby="consent-title" className="consent">
          <div>
            <strong id="consent-title">Cookies</strong>
            <p>
              We use essential cookies to keep you signed in and your cart working.
              {analyticsDomain ? " With your permission we also use privacy-friendly analytics to understand how the site is used." : " We don't use advertising or tracking cookies."}{" "}
              <Link href="/privacy">Privacy policy</Link>
            </p>
          </div>
          <div className="row">
            <button onClick={() => decide("declined")}>{analyticsDomain ? "Decline analytics" : "Essential only"}</button>
            {analyticsDomain && <button onClick={() => decide("accepted")}>Accept analytics</button>}
            {!analyticsDomain && <button onClick={() => decide("accepted")}>OK</button>}
          </div>
        </div>
      )}
    </>
  );
}

export function CookieSettingsButton() {
  return (
    <button className="linklike" onClick={() => window.dispatchEvent(new Event("open-cookie-settings"))}>
      Cookie settings
    </button>
  );
}
