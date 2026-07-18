/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: ".next-clean",
  // Enable standalone output when building inside Docker (set BUILD_STANDALONE=1)
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
