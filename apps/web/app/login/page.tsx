import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";


export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      <AuthForm mode="login" next={next} />
      <p className="muted">New here? <Link href="/register">Create an account</Link></p>
    </>
  );
}
