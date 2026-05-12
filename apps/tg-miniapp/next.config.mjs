/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: '/tg',
  transpilePackages: ['@tonconnect/ui-react', '@telegram-apps/sdk-react'],
  poweredByHeader: false,
  compress: true,
};

export default nextConfig;
// Health probe lives at /tg/health (inside basePath). The deploy script
// healthcheck is conditional on the pm2 process's PORT env var — by
// omitting PORT from the tma pm2 entry the check is skipped (the app
// still binds 3100 via the `next start -p 3100` argument).
