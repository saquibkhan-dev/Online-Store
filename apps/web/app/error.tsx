"use client";
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <>
      <h1>Something went wrong</h1>
      <p>We hit a problem loading this page. Your data is safe.</p>
      <button onClick={reset}>Try again</button>
    </>
  );
}
