// dashboard/next.config.mjs: how Next.js builds the dashboard. The server code imports a few agent
// libraries (the Firestore client, collection names, the command signature) so the dashboard and the
// agent share one definition of each. Those live outside dashboard/, so the build's root is the repo.
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // A self-contained server in .next/standalone, which the Dockerfile copies into the image.
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  reactStrictMode: true,
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into dashboard/. This repo's guidance for
  // coding agents is the root DEVELOPING.md.
  agentRules: false,
};

export default nextConfig;
