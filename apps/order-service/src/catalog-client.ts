import { Errors } from "@commerce/shared";
import { z } from "zod";

export interface CatalogProduct {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
}

export interface CatalogClient {
  /** Returns only ACTIVE products; unknown or deleted ids are simply absent. */
  batch(ids: string[], ctx?: { requestId?: string; correlationId?: string }): Promise<CatalogProduct[]>;
}

const responseSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), name: z.string(), priceMinor: z.number().int(), currency: z.string() }))
});

export class HttpCatalogClient implements CatalogClient {
  constructor(private readonly baseUrl: string, private readonly internalToken: string, private readonly timeoutMs = 2500) {}

  async batch(ids: string[], ctx: { requestId?: string; correlationId?: string } = {}): Promise<CatalogProduct[]> {
    if (ids.length === 0) return [];
    try {
      const res = await fetch(`${this.baseUrl}/internal/products/batch?ids=${ids.join(",")}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          "x-internal-auth": this.internalToken,
          ...(ctx.requestId ? { "x-request-id": ctx.requestId } : {}),
          ...(ctx.correlationId ? { "x-correlation-id": ctx.correlationId } : {})
        }
      });
      if (!res.ok) throw new Error(`catalog responded ${res.status}`);
      return responseSchema.parse(await res.json()).items;
    } catch {
      throw Errors.unavailable("Product catalogue is temporarily unavailable");
    }
  }
}
