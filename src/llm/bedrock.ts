/** AWS Bedrock Converse provider — the "production" LLM backend (mirrors the
 * original Spring AI `bedrock-converse` setup with amazon.nova-lite). */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type Tool,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type { ChatMessage, LlmProvider, LlmResponse, ToolCall, ToolSpec } from "../types.js";

export class BedrockLlmProvider implements LlmProvider {
  readonly name = "bedrock";
  private client: BedrockRuntimeClient;

  constructor(
    private modelId: string,
    region: string,
  ) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async converse(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<LlmResponse> {
    const command = new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: system }],
      messages: messages.map(toBedrockMessage),
      toolConfig: tools.length ? { tools: tools.map(toBedrockTool) } : undefined,
      inferenceConfig: { temperature: 0.2, maxTokens: 1024 },
    });

    const res = await this.client.send(command);
    const blocks = res.output?.message?.content ?? [];

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block.text) text += block.text;
      if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId!,
          name: block.toolUse.name!,
          input: (block.toolUse.input as Record<string, unknown>) ?? {},
        });
      }
    }
    return { text: text || undefined, toolCalls };
  }
}

function toBedrockTool(spec: ToolSpec): Tool {
  return {
    toolSpec: {
      name: spec.name,
      description: spec.description,
      // The SDK types `json` as smithy DocumentType; our JSON Schema is compatible.
      inputSchema: { json: spec.inputSchema as unknown as DocumentType },
    },
  };
}

function toBedrockMessage(msg: ChatMessage): Message {
  if (msg.role === "user") {
    return { role: "user", content: [{ text: msg.text }] };
  }
  if (msg.role === "assistant") {
    const content: ContentBlock[] = [];
    if (msg.text) content.push({ text: msg.text });
    for (const tc of msg.toolCalls ?? []) {
      content.push({
        toolUse: { toolUseId: tc.id, name: tc.name, input: tc.input as DocumentType },
      });
    }
    return { role: "assistant", content };
  }
  // tool result → Bedrock models tool results as a user-role message
  return {
    role: "user",
    content: [
      {
        toolResult: {
          toolUseId: msg.toolCallId,
          content: [{ text: msg.result }],
        },
      },
    ],
  };
}
