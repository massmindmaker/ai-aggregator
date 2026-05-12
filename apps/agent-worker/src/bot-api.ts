/**
 * Telegram Bot API helper for DM notifications from the agent-worker.
 * Used to ping the user when their agent run finishes (or fails).
 *
 * Reads TG_BOT_TOKEN from env; silently no-ops if missing so the worker
 * keeps running in environments without a configured bot.
 */

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN ?? '';
const BASE = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : '';
const APP_BASE_URL =
  process.env.TMA_APP_BASE_URL ?? 'https://app.ai-aggregator.ru/tg';

export interface SendOpts {
  parseMode?: 'HTML' | 'MarkdownV2';
  disablePreview?: boolean;
}

export async function sendBotMessage(
  chatId: number | string,
  text: string,
  opts: SendOpts = {},
): Promise<boolean> {
  if (!BASE) return false;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: opts.parseMode ?? 'HTML',
        disable_web_page_preview: opts.disablePreview ?? true,
      }),
    });
    if (!res.ok) {
      console.warn('[bot-api] sendMessage failed', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[bot-api] sendMessage threw', (e as Error).message);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildRunCompletedMessage(args: {
  agentName: string;
  agentId: string;
  costRub: number;
  output: string;
}): string {
  const preview = args.output.slice(0, 240);
  const tail = args.output.length > 240 ? '…' : '';
  return (
    `✓ Агент <b>${escapeHtml(args.agentName)}</b> готов\n` +
    `Стоимость: <b>${args.costRub.toFixed(2)} ₽</b>\n\n` +
    `${escapeHtml(preview)}${tail}\n\n` +
    `<a href="${APP_BASE_URL}/agents/${args.agentId}">Открыть в Mini App</a>`
  );
}

export function buildRunFailedMessage(args: {
  agentName: string;
  agentId: string;
  error: string;
}): string {
  return (
    `⚠️ Агент <b>${escapeHtml(args.agentName)}</b> не справился\n` +
    `Причина: <code>${escapeHtml(args.error)}</code>\n\n` +
    `<a href="${APP_BASE_URL}/agents/${args.agentId}">Открыть в Mini App</a>`
  );
}
