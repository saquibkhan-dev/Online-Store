import { Errors, TtlCache } from "@commerce/shared";
import type { Db } from "./db";
import { Prisma } from "./generated/client";

export interface ProductInput {
  name: string;
  slug: string;
  description: string;
  priceMinor: number;
  currency: string;
  categoryId?: string | null;
}

export interface ListQuery {
  search?: string;
  category?: string;
  sort: "newest" | "price_asc" | "price_desc" | "name";
  minPrice?: number;
  maxPrice?: number;
  page: number;
  limit: number;
}

const ORDER_BY: Record<ListQuery["sort"], Prisma.ProductOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }, { id: "asc" }],
  price_asc: [{ priceMinor: "asc" }, { id: "asc" }],
  price_desc: [{ priceMinor: "desc" }, { id: "asc" }],
  name: [{ name: "asc" }, { id: "asc" }]
};

function mapWriteError(err: unknown, what: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") throw Errors.conflict("SLUG_EXISTS", `${what} slug already exists`);
    if (err.code === "P2025") throw Errors.notFound(what);
    if (err.code === "P2003") throw Errors.badRequest("INVALID_CATEGORY", "Category does not exist");
  }
  throw err;
}

type ListResult = { items: unknown[]; total: number; page: number; limit: number };

export class CatalogService {
  // Read-heavy, rarely-changing data: a few seconds of caching absorbs traffic spikes. Every write clears it, and the
  // TTL bounds staleness on other replicas.
  private readonly lists = new TtlCache<ListResult>(Number(process.env.CATALOG_CACHE_SECONDS ?? 10) * 1000, 300);
  private readonly categories = new TtlCache<unknown[]>(Number(process.env.CATALOG_CACHE_SECONDS ?? 10) * 6000, 5);

  constructor(private readonly db: Db) {}

  private invalidate() {
    this.lists.clear();
    this.categories.clear();
  }

  listProducts(q: ListQuery): Promise<ListResult> {
    return this.lists.wrap(JSON.stringify(q), () => this.queryProducts(q));
  }

  private async queryProducts(q: ListQuery) {
    const where: Prisma.ProductWhereInput = {
      status: "ACTIVE",
      ...(q.category ? { category: { slug: q.category } } : {}),
      ...(q.minPrice !== undefined || q.maxPrice !== undefined ? { priceMinor: { gte: q.minPrice, lte: q.maxPrice } } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { description: { contains: q.search, mode: "insensitive" } }] }
        : {})
    };
    const [items, total] = await Promise.all([
      this.db.product.findMany({ where, orderBy: ORDER_BY[q.sort], skip: (q.page - 1) * q.limit, take: q.limit, include: { category: true } }),
      this.db.product.count({ where })
    ]);
    return { items, total, page: q.page, limit: q.limit };
  }

  async getProduct(id: string) {
    const product = await this.db.product.findFirst({ where: { id, status: "ACTIVE" }, include: { category: true } });
    if (!product) throw Errors.notFound("Product");
    return product;
  }

  /** Authoritative name/price lookup for other services. Returns only ACTIVE products. */
  async batch(ids: string[]) {
    return this.db.product.findMany({
      where: { id: { in: ids }, status: "ACTIVE" },
      select: { id: true, name: true, priceMinor: true, currency: true }
    });
  }

  async createProduct(input: ProductInput) {
    try {
      const created = await this.db.product.create({ data: input });
      this.invalidate();
      return created;
    } catch (err) {
      return mapWriteError(err, "Product");
    }
  }

  async updateProduct(id: string, input: Partial<ProductInput>) {
    try {
      const updated = await this.db.product.update({ where: { id, status: "ACTIVE" }, data: input });
      this.invalidate();
      return updated;
    } catch (err) {
      return mapWriteError(err, "Product");
    }
  }

  async deleteProduct(id: string): Promise<void> {
    await this.db.product.updateMany({ where: { id, status: "ACTIVE" }, data: { status: "DELETED" } });
    this.invalidate();
  }

  async listCategories() {
    return this.categories.wrap("all", () => this.db.category.findMany({ orderBy: { name: "asc" } }));
  }

  async createCategory(input: { name: string; slug: string }) {
    try {
      const created = await this.db.category.create({ data: input });
      this.invalidate();
      return created;
    } catch (err) {
      return mapWriteError(err, "Category");
    }
  }

  async updateCategory(id: string, input: { name?: string; slug?: string }) {
    try {
      const updated = await this.db.category.update({ where: { id }, data: input });
      this.invalidate();
      return updated;
    } catch (err) {
      return mapWriteError(err, "Category");
    }
  }

  async deleteCategory(id: string): Promise<void> {
    await this.db.category.deleteMany({ where: { id } });
    this.invalidate();
  }
}
