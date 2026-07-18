'use client';

import * as React from 'react';
import { Send, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import type { CatalogModel } from '@/lib/marketplace/catalog';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  model: CatalogModel;
}

/**
 * Chat playground UI. Sends prompt to /api/playground/run, which streams
 * real SSE delta events from the model via the gateway (rate-limited to
 * 5 requests/day/IP, see route.ts). Falls back to a local canned response
 * only outside production when GATEWAY_SYSTEM_API_KEY is unset.
 */
export function PlaygroundEmbed({ model }: Props) {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const outputRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    outputRef.current?.scrollTo({
      top: outputRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  const canSubmit = input.trim().length > 0 && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    const userMsg: Message = { role: 'user', content: input.trim() };
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '' }]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/playground/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.slug, prompt: userMsg.content }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Ошибка ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const evt of events) {
          const line = evt.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.done) continue;
            if (typeof payload.delta === 'string') {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === 'assistant') {
                  next[next.length - 1] = {
                    ...last,
                    content: last.content + payload.delta,
                  };
                }
                return next;
              });
            }
          } catch {
            // ignore malformed event
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Неизвестная ошибка');
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setMessages([]);
    setError(null);
  }

  return (
    <Card>
      <CardContent className="p-0 flex flex-col h-[600px]">
        {/* Output */}
        <div
          ref={outputRef}
          className="flex-1 overflow-y-auto p-4 space-y-4"
          aria-live="polite"
          aria-busy={loading}
        >
          {messages.length === 0 ? (
            <EmptyPrompt modelName={model.name} />
          ) : (
            messages.map((m, i) => <MessageBubble key={i} message={m} loading={loading && i === messages.length - 1} />)
          )}
          {error && (
            <div className="text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        {/* Input */}
        <form
          onSubmit={handleSubmit}
          className="border-t border-border p-3 flex gap-2 items-end"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Напишите сообщение…"
            rows={2}
            className="flex-1 resize-none bg-transparent rounded-md border border-border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={loading}
            aria-label="Сообщение"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
          />
          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={!canSubmit} size="sm">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              <span className="ms-1">Отправить</span>
            </Button>
            {messages.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={reset}
                disabled={loading}
              >
                <RotateCcw className="h-3 w-3 me-1" aria-hidden />
                Сброс
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function MessageBubble({
  message,
  loading,
}: {
  message: Message;
  loading: boolean;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          isUser
            ? 'rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm max-w-[80%] whitespace-pre-wrap break-words'
            : 'rounded-lg bg-secondary text-foreground px-4 py-2 text-sm max-w-[80%] whitespace-pre-wrap break-words'
        }
      >
        {message.content || (loading ? <span className="text-muted-foreground">печатает…</span> : null)}
      </div>
    </div>
  );
}

function EmptyPrompt({ modelName }: { modelName: string }) {
  return (
    <div className="h-full flex items-center justify-center text-center text-muted-foreground text-sm px-6">
      <div>
        <p>
          Попробуйте <span className="text-foreground font-medium">{modelName}</span> прямо здесь.
        </p>
        <p className="mt-1">Напишите запрос и нажмите Enter.</p>
        <p className="mt-4 text-xs">
          Отвечает реальная модель. Демо-доступ: 5 запросов в сутки на IP.
        </p>
      </div>
    </div>
  );
}
