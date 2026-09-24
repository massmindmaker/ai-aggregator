import {
  guard,
  owner as createOwner,
  runtime as createRuntime,
  slug,
} from './stored-chat-mounted.native.fixture';

export { guard, slug };

export async function runtime() {
  return createRuntime({
    executionMode: 'stored_chat_embeddings_completions',
    cachingDiscount: '1',
    providerCompletionTokens: 5,
    providerCachedInputTokens: 0,
    providerText: 'native completion text',
  });
}
export type Runtime = Awaited<ReturnType<typeof runtime>>;

export async function owner(r: Runtime) {
  return createOwner(r, {
    path: '/v1/completions',
    body: { model: slug, prompt: 'private native completion prompt', max_tokens: 10 },
    initialPaygCredits: 10_000,
  });
}
export type Owner = Awaited<ReturnType<typeof owner>>;
