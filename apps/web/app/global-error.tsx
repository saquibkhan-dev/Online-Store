"use client";

// Last-resort boundary: renders when the root layout itself fails, so it cannot rely on the app's styles or components.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "36rem", margin: "4rem auto", padding: "0 1rem" }}>
        <h1>Something went wrong</h1>
        <p>We hit an unexpected problem. Your data is safe. Please try again.</p>
        <button onClick={reset} style={{ padding: "0.6rem 1rem", minHeight: "44px" }}>Try again</button>
      </body>
    </html>
  );
}
