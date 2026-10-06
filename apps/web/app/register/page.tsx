import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";


export const metadata: Metadata = { title: "Create your account", description: "Create a free account to order, track deliveries and manage your orders." };

export default function RegisterPage() {
  return (
    <>
      <h1>Create account</h1>
      <AuthForm mode="register" />
      <p className="muted">Already registered? <Link href="/login">Sign in</Link></p>
    </>
  );
}
