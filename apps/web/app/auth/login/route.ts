import { proxyAuth } from "@/lib/auth-proxy";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => proxyAuth(req, "login");
