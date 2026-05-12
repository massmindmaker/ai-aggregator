/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: '/tg',
  transpilePackages: ['@tonconnect/ui-react', '@telegram-apps/sdk-react'],
  poweredByHeader: false,
  compress: true,
  // Expose /health at the port root (outside basePath) so pm2/deploy.sh
  // can hit http://127.0.0.1:3100/health directly without going through nginx.
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/health', destination: '/tg/health', basePath: false },
      ],
    };
  },
};

export default nextConfig;
