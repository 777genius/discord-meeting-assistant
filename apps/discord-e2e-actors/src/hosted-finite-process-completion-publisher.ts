interface ConversationObserverCompletionContext {
  readonly runId: string;
}

export function publishConversationObserverCompletion(
  config: ConversationObserverCompletionContext,
  outputPaths: readonly string[],
): void {
  process.stdout.write(`${JSON.stringify({
    kind: "conversation-observer-completion",
    outputPaths,
    runId: config.runId,
    status: "completed",
  })}\n`);
}
