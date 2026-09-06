import { describe, it, expect, afterEach, vi } from 'vitest';
import { sendAlert } from '../bot.js';

const ORIG_TOKEN = process.env.TELEGRAM_ALERT_BOT_TOKEN;
const ORIG_CHAT = process.env.TELEGRAM_ALERT_CHAT_ID;

afterEach(() => {
  if (ORIG_TOKEN) process.env.TELEGRAM_ALERT_BOT_TOKEN = ORIG_TOKEN;
  else delete process.env.TELEGRAM_ALERT_BOT_TOKEN;
  if (ORIG_CHAT) process.env.TELEGRAM_ALERT_CHAT_ID = ORIG_CHAT;
  else delete process.env.TELEGRAM_ALERT_CHAT_ID;
  vi.restoreAllMocks();
});

describe('sendAlert', () => {
  it('returns ok with no token/chat (mock mode)', async () => {
    delete process.env.TELEGRAM_ALERT_BOT_TOKEN;
    delete process.env.TELEGRAM_ALERT_CHAT_ID;
    const r = await sendAlert('test', 'info');
    expect(r.ok).toBe(true);
  });

  it('calls Telegram Bot API when configured', async () => {
    process.env.TELEGRAM_ALERT_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_ALERT_CHAT_ID = '123';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
      })
    );
    const r = await sendAlert('something failing', 'critical');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.messageId).toBe(7);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('bottok/sendMessage');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.chat_id).toBe('123');
    expect(body.text).toContain('CRITICAL');
    expect(body.text).toContain('something failing');
    expect(body.parse_mode).toBe('HTML');
  });

  it('returns error on Telegram failure', async () => {
    process.env.TELEGRAM_ALERT_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_ALERT_CHAT_ID = '123';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 })
    );
    const r = await sendAlert('x', 'warning');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('chat not found');
  });
});
