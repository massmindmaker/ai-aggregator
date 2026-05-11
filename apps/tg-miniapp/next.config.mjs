/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: '/tg',
  transpilePackages: ['@tonconnect/ui-react', '@telegram-apps/sdk-react'],
  poweredByHeader: false,
  compress: true,
};

export default nextConfig;
