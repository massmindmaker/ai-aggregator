'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/Tabs';
import type { CatalogModel, ModelType } from '@/lib/marketplace/catalog';

type Lang = 'curl' | 'node' | 'python';

interface Props {
  model: CatalogModel;
}

/**
 * Renders curl / Node.js / Python code samples for the given model,
 * picking the right endpoint template based on model.type.
 */
export function CodeExampleTabs({ model }: Props) {
  const samples = buildSamples(model);
  return (
    <Tabs defaultValue="curl">
      <TabsList>
        <TabsTrigger value="curl">curl</TabsTrigger>
        <TabsTrigger value="node">Node.js</TabsTrigger>
        <TabsTrigger value="python">Python</TabsTrigger>
      </TabsList>
      {(Object.keys(samples) as Lang[]).map((lang) => (
        <TabsContent key={lang} value={lang}>
          <CodeBlock code={samples[lang]} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };
  return (
    <div className="relative rounded-md border border-border bg-secondary">
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Скопировано' : 'Копировать'}
        className="absolute right-2 top-2 rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? (
          <Check className="h-4 w-4" aria-hidden />
        ) : (
          <Copy className="h-4 w-4" aria-hidden />
        )}
      </button>
      <pre className="overflow-auto p-4 text-xs font-mono text-foreground/90 whitespace-pre-wrap break-all">
        {code}
      </pre>
    </div>
  );
}

const BASE = 'https://api.aiag.ru';

function buildSamples(model: CatalogModel): Record<Lang, string> {
  switch (modalityBucket(model.type)) {
    case 'chat':
      return chatSamples(model.slug);
    case 'image':
      return imageSamples(model.slug);
    case 'audio-tts':
      return audioSamples(model.slug);
    case 'unsupported':
      return unavailableSamples();
    case 'video':
      return videoSamples(model.slug);
    case 'embedding':
      return embeddingSamples(model.slug);
    default:
      return chatSamples(model.slug);
  }
}

function modalityBucket(t: ModelType): string {
  if (t === 'image') return 'image';
  if (t === 'text-to-speech') return 'audio-tts';
  if (t === 'speech-to-text') return 'unsupported';
  if (t === 'video') return 'video';
  if (t === 'embedding') return 'embedding';
  return 'chat';
}

function chatSamples(slug: string): Record<Lang, string> {
  return {
    curl: `curl ${BASE}/v1/chat/completions \\
  -H "Authorization: Bearer $AIAG_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${slug}",
    "stream": true,
    "messages": [{"role": "user", "content": "Привет!"}]
  }'`,
    node: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.AIAG_API_KEY,
  baseURL: '${BASE}/v1',
});

const stream = await client.chat.completions.create({
  model: '${slug}',
  messages: [{ role: 'user', content: 'Привет!' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}`,
    python: `from openai import OpenAI

client = OpenAI(
    api_key=os.environ["AIAG_API_KEY"],
    base_url="${BASE}/v1",
)

stream = client.chat.completions.create(
    model="${slug}",
    messages=[{"role": "user", "content": "Привет!"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`,
  };
}

function imageSamples(slug: string): Record<Lang, string> {
  return {
    curl: `curl ${BASE}/v1/images/generations \\
  -H "Authorization: Bearer $AIAG_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${slug}",
    "prompt": "закат над Москва-Сити",
    "n": 1,
    "size": "1024x1024"
  }'`,
    node: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.AIAG_API_KEY,
  baseURL: '${BASE}/v1',
});

const res = await client.images.generate({
  model: '${slug}',
  prompt: 'закат над Москва-Сити',
  n: 1,
  size: '1024x1024',
});

console.log(res.data[0].url);`,
    python: `from openai import OpenAI

client = OpenAI(
    api_key=os.environ["AIAG_API_KEY"],
    base_url="${BASE}/v1",
)

res = client.images.generate(
    model="${slug}",
    prompt="закат над Москва-Сити",
    n=1,
    size="1024x1024",
)
print(res.data[0].url)`,
  };
}

function audioSamples(slug: string): Record<Lang, string> {
  return {
    curl: `curl ${BASE}/v1/audio/speech \\
  -H "Authorization: Bearer $AIAG_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${slug}",
    "input": "Привет, мир",
    "voice": "alloy"
  }' --output speech.mp3`,
    node: `import fs from 'node:fs';
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.AIAG_API_KEY,
  baseURL: '${BASE}/v1',
});

const res = await client.audio.speech.create({
  model: '${slug}',
  voice: 'alloy',
  input: 'Привет, мир',
});

const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync('speech.mp3', buf);`,
    python: `from openai import OpenAI

client = OpenAI(
    api_key=os.environ["AIAG_API_KEY"],
    base_url="${BASE}/v1",
)

res = client.audio.speech.create(
    model="${slug}",
    voice="alloy",
    input="Привет, мир",
)
res.write_to_file("speech.mp3")`,
  };
}

function sttSamples(slug: string): Record<Lang, string> {
  return {
    curl: `curl ${BASE}/v1/audio/transcriptions \\
  -H "Authorization: Bearer $AIAG_API_KEY" \\
  -F "model=${slug}" \\
  -F "file=@audio.mp3"`,
    node: `import fs from 'node:fs';
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.AIAG_API_KEY,
  baseURL: '${BASE}/v1',
});

const res = await client.audio.transcriptions.create({
  model: '${slug}',
  file: fs.createReadStream('audio.mp3'),
});

console.log(res.text);`,
    python: `from openai import OpenAI

client = OpenAI(
    api_key=os.environ["AIAG_API_KEY"],
    base_url="${BASE}/v1",
)

with open("audio.mp3", "rb") as f:
    res = client.audio.transcriptions.create(model="${slug}", file=f)
print(res.text)`,
  };
}

function videoSamples(slug: string): Record<Lang, string> {
  return {
    curl: `# Шаг 1 — отправить prediction
PRED=$(curl -s ${BASE}/v1/predictions \\
  -H "Authorization: Bearer $AIAG_API_KEY" \\
  -d '{"model": "${slug}", "input": {"prompt": "horse galloping"}}' | jq -r .id)

# Шаг 2 — опрашивать статус (30-60 сек)
while true; do
  RES=$(curl -s ${BASE}/v1/predictions/$PRED \\
    -H "Authorization: Bearer $AIAG_API_KEY")
  STATUS=$(echo $RES | jq -r .status)
  [ "$STATUS" = "succeeded" ] && echo $RES | jq -r .output && break
  [ "$STATUS" = "failed" ] && echo "Failed" && break
  sleep 3
done`,
    node: `const pred = await fetch('${BASE}/v1/predictions', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.AIAG_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ model: '${slug}', input: { prompt: 'horse galloping' } }),
}).then((r) => r.json());

while (true) {
  const r = await fetch(\`${BASE}/v1/predictions/\${pred.id}\`, {
    headers: { Authorization: \`Bearer \${process.env.AIAG_API_KEY}\` },
  }).then((r) => r.json());
  if (r.status === 'succeeded') { console.log(r.output); break; }
  if (r.status === 'failed') throw new Error('Failed');
  await new Promise((res) => setTimeout(res, 3000));
}`,
    python: `import os, time, requests

h = {"Authorization": f"Bearer {os.environ['AIAG_API_KEY']}"}
pred = requests.post(
    "${BASE}/v1/predictions",
    headers=h,
    json={"model": "${slug}", "input": {"prompt": "horse galloping"}},
).json()

while True:
    r = requests.get(f"${BASE}/v1/predictions/{pred['id']}", headers=h).json()
    if r["status"] == "succeeded":
        print(r["output"]); break
    if r["status"] == "failed":
        raise RuntimeError("Failed")
    time.sleep(3)`,
  };
}

function embeddingSamples(slug: string): Record<Lang, string> {
  return {
    curl: `curl ${BASE}/v1/embeddings \\
  -H "Authorization: Bearer $AIAG_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${slug}", "input": "Текст для векторизации"}'`,
    node: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.AIAG_API_KEY,
  baseURL: '${BASE}/v1',
});

const res = await client.embeddings.create({
  model: '${slug}',
  input: 'Текст для векторизации',
});

console.log(res.data[0].embedding.length);`,
    python: `from openai import OpenAI

client = OpenAI(
    api_key=os.environ["AIAG_API_KEY"],
    base_url="${BASE}/v1",
)

res = client.embeddings.create(model="${slug}", input="Текст для векторизации")
print(len(res.data[0].embedding))`,
  };
}
