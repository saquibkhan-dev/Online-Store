"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "./api";

export function AddToCart({ productId, name, signedIn }: { productId: string; name: string; signedIn: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "added">("idle");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!signedIn) return router.push("/login?next=/");
    setState("busy");
    setError(null);
    try {
      await api("/bff/api/cart/items", { method: "POST", body: JSON.stringify({ productId, quantity: 1 }) });
      setState("added");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add to cart");
      setState("idle");
    }
  }

  return (
    <div>
      <button onClick={add} disabled={state === "busy"} aria-label={`Add ${name} to cart`}>
        {state === "busy" ? "Adding…" : state === "added" ? "Added ✓" : "Add to cart"}
      </button>
      <p role="status" className="error muted">{error}</p>
    </div>
  );
}
