"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, ApiError } from "./api";

/** Only same-site relative paths are honoured, so ?next= cannot be used as an open redirect. */
export const safeNext = (next: string | undefined) => (next && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : "/");

type Errors = Partial<Record<"name" | "email" | "password", string>>;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Mirrors the server rules so people get instant, specific feedback; the server remains the authority. */
export function validate(mode: "login" | "register", v: { name: string; email: string; password: string }): Errors {
  const errors: Errors = {};
  if (mode === "register" && (v.name.trim().length < 2 || v.name.length > 80)) errors.name = "Enter your name (2–80 characters).";
  if (!EMAIL.test(v.email.trim())) errors.email = "Enter a valid email address, like name@example.com.";
  if (mode === "register") {
    if (v.password.length < 10) errors.password = "Use at least 10 characters.";
    else if (new TextEncoder().encode(v.password).length > 72) errors.password = "That password is too long (72 bytes maximum).";
  } else if (!v.password) errors.password = "Enter your password.";
  return errors;
}

export function AuthForm({ mode, next }: { mode: "login" | "register"; next?: string }) {
  const router = useRouter();
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const startedAt = useRef(Date.now());
  const register = mode === "register";

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const values = { name: String(form.get("name") ?? ""), email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") };
    const found = validate(mode, values);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      (e.currentTarget.querySelector("[aria-invalid='true']") as HTMLElement | null)?.focus();
      return;
    }
    setBusy(true);
    try {
      await api(`/auth/${mode}`, {
        method: "POST",
        // The last two fields are spam traps: `company_website` is hidden from people, and bots posting directly skip the timer.
        body: JSON.stringify({ ...values, ...(register ? {} : { name: undefined }), company_website: form.get("company_website"), formStartedAt: startedAt.current })
      });
      router.push(safeNext(next));
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        const fieldErrors: Errors = {};
        for (const d of err.details) if (d.path === "name" || d.path === "email" || d.path === "password") fieldErrors[d.path] = d.message;
        setErrors(fieldErrors);
        if (err.code === "EMAIL_EXISTS") setErrors({ email: "That email is already registered. Try signing in instead." });
        else if (Object.keys(fieldErrors).length === 0) setFormError(err.message);
      } else setFormError("Something went wrong");
      setBusy(false);
    }
  }

  const field = (id: keyof Errors) => ({ "aria-invalid": errors[id] ? ("true" as const) : undefined, "aria-describedby": errors[id] ? `${id}-error` : undefined });
  return (
    <form className="stack" onSubmit={submit} noValidate>
      {register && (
        <label>Name<input name="name" autoComplete="name" maxLength={80} {...field("name")} />
          <span id="name-error" className="error field-error">{errors.name}</span></label>
      )}
      <label>Email<input name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} {...field("email")} />
        <span id="email-error" className="error field-error">{errors.email}</span></label>
      <label>
        Password
        <input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} {...field("password")} />
        {register && !errors.password && <span className="muted">At least 10 characters.</span>}
        <span id="password-error" className="error field-error">{errors.password}</span>
      </label>
      {/* Honeypot: invisible and unreachable for people and assistive tech; automated form-fillers tend to complete it. */}
      <div aria-hidden="true" className="hp"><label>Company website<input name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
      <p role="alert" className="error">{formError}</p>
      <button className="primary" disabled={busy}>{busy ? "Please wait…" : register ? "Create account" : "Sign in"}</button>
    </form>
  );
}
