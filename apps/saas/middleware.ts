import { NextRequest, NextResponse } from "next/server";

function unauthorizedResponse() {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="DZ Fraud Shield Admin"'
    }
  });
}

export function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const requiresAdmin = pathname.startsWith("/admin") || pathname.startsWith("/api/v1/admin/");

  if (!requiresAdmin) {
    return NextResponse.next();
  }

  const expectedUser = process.env.ADMIN_NETWORK_USER;
  const expectedPass = process.env.ADMIN_NETWORK_PASSWORD;

  if (!expectedUser || !expectedPass) {
    const missingVars = [
      !expectedUser ? "ADMIN_NETWORK_USER" : null,
      !expectedPass ? "ADMIN_NETWORK_PASSWORD" : null
    ].filter(Boolean);

    return new NextResponse(`Admin credentials not configured. Missing environment variables: ${missingVars.join(", ")}`, {
      status: 500
    });
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Basic ")) {
    return unauthorizedResponse();
  }

  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  const [username, password] = decoded.split(":");

  if (username !== expectedUser || password !== expectedPass) {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/v1/admin/:path*"]
};
