// Alias of /api/health for the deploy script's health-check curl, which hits
// /health (not /api/health). Re-exports the same handler so they stay in sync.
export { GET } from '../api/health/route';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
