export interface FieldIssue { path: string; message: string }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: FieldIssue[] = []) {
    super(message);
  }
}

/** Browser-side call to the BFF. Throws ApiError with the server's message for any non-2xx response. */
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) } });
  } catch {
    throw new ApiError(0, "NETWORK", "Network problem. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: unknown } };
  if (!res.ok) {
    const raw = data.error?.details;
    const details = Array.isArray(raw) ? raw.filter((d): d is FieldIssue => typeof d?.path === "string" && typeof d?.message === "string") : [];
    throw new ApiError(res.status, data.error?.code ?? "ERROR", data.error?.message ?? "Something went wrong", details);
  }
  return data as T;
}
