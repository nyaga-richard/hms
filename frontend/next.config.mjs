import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for the Docker image (see frontend/Dockerfile). The monorepo root is the
  // tracing root so hoisted workspace dependencies are included.
  output: 'standalone',
  experimental: { outputFileTracingRoot: path.join(__dirname, '../'), serverActions: { allowedOrigins: ['*'] } },
  async rewrites() {
    // Browser talks to same-origin /api/*; Next proxies to the backend (works behind the preview proxy and in Docker).
    // NOTE: rewrites are resolved when the app is built/started, so set BACKEND_INTERNAL_URL for `next build` in Docker.
    const target = process.env.BACKEND_INTERNAL_URL ?? process.env.API_URL ?? 'http://localhost:4000';
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }, { source: '/uploads/:path*', destination: `${target}/uploads/:path*` }];
  },
};
export default nextConfig;
