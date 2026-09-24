import { describe, expect, it } from "vitest";

import {
  parseStoredHttpCompletionResponse,
  projectStoredHttpCompletionResponse,
} from "../billing/http-storage-result";

const chat = {
  id: "chatcmpl_1",
  object: "chat.completion" as const,
  created: 1,
  model: "openai/gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: { role: "assistant" as const, content: "answer" },
      finish_reason: "stop" as const,
    },
  ],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 5,
    total_tokens: 105,
    cached_input_tokens: 0,
  },
};

describe("stored text completion result", () => {
  it("projects the exact text_completion DTO from a sanitized chat response", () => {
    expect(projectStoredHttpCompletionResponse(chat)).toEqual({
      id: "chatcmpl_1",
      object: "text_completion",
      created: 1,
      model: "openai/gpt-4o-mini",
      choices: [
        {
          text: "answer",
          index: 0,
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: chat.usage,
    });
  });

  it("projects accepted null chat content to an empty string", () => {
    expect(projectStoredHttpCompletionResponse({
      ...chat,
      choices: [{ ...chat.choices[0], message: { role: "assistant", content: null } }],
    }).choices[0].text).toBe("");
  });

  it("requires the explicit text_completion object and exact public keys", () => {
    const completion = projectStoredHttpCompletionResponse(chat);
    expect(parseStoredHttpCompletionResponse(completion)).toEqual(completion);
    expect(() => parseStoredHttpCompletionResponse({ ...completion, object: "chat.completion" })).toThrow();
    expect(() => parseStoredHttpCompletionResponse({ ...completion, provider: "secret" })).toThrow();
    expect(() => parseStoredHttpCompletionResponse({
      ...completion,
      choices: [{ ...completion.choices[0], logprobs: [] }],
    })).toThrow();
  });
});
