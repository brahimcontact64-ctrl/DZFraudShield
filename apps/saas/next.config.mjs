/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the default `.next` distDir — Vercel's Next.js Runtime always looks
  // for build output there and does not honor a custom distDir, regardless
  // of any "Output Directory" dashboard override.
  // Enable standalone output when building inside Docker (set BUILD_STANDALONE=1)
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
