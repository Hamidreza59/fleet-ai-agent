/** Per-fleet-manager conversation memory.
 *
 * Mirrors the original demo's per-manager `PromptChatMemoryAdvisor`: each fleet
 * manager gets an independent, bounded conversation history so follow-up
 * questions ("what about that Tesla?") keep context. In-memory only.
 */

import type { ChatMessage } from "../types.js";

export class ChatMemory {
  private store = new Map<string, ChatMessage[]>();

  constructor(private maxMessages = 40) {}

  history(key: string): ChatMessage[] {
    return this.store.get(key) ?? [];
  }

  append(key: string, messages: ChatMessage[]): void {
    const next = [...this.history(key), ...messages];
    // Keep the most recent window so prompts stay bounded.
    this.store.set(key, next.slice(-this.maxMessages));
  }

  clear(key: string): void {
    this.store.delete(key);
  }
}
