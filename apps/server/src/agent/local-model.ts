import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Model, type Provider, type StreamOptions, type ToolCall, type TranscriptContext, type Usage } from '@earendil-works/pi-ai';
import type { AgentUsage } from '@pineterm/contracts';

const REPORTED_USAGE = new WeakMap<Usage, AgentUsage>();
/** Separate real provider counts from mandatory SDK placeholder zeros. */
export function reportedLocalUsage(value: Usage): AgentUsage | undefined { return REPORTED_USAGE.get(value); }

/** Public Pi provider adapter for actual credentialless local OpenAI-compatible servers.
 * Pi 0.99.2's completions transport rejects empty auth; do not supply a pretend key. */
export function localModelProvider(model: Model<'openai-completions'>, apiKey?: string): Provider<'openai-completions'> {
  const stream = (selected: Model<'openai-completions'>, context: TranscriptContext, options: Pick<StreamOptions, 'signal' | 'maxTokens'> = {}) => {
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, content: [], stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const messages: Record<string, unknown>[] = [{ role: 'system', content: getCurrentSystemPrompt(context.messages) }];
        for (const item of context.messages) {
          if (item.role === 'system') continue;
          if (item.role === 'user') messages.push({ role: 'user', content: typeof item.content === 'string' ? item.content : item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') });
          else if (item.role === 'toolResult') messages.push({ role: 'tool', tool_call_id: item.toolCallId, content: item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') });
          else {
            const calls = item.content.filter((part): part is ToolCall => part.type === 'toolCall');
            messages.push({ role: 'assistant', content: item.content.filter(part => part.type === 'text').map(part => part.text).join('') || null, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) });
          }
        }
        const tools = getCurrentTools(context.messages).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
        const payload = { model: selected.id, messages, stream: true, stream_options: { include_usage: true }, max_tokens: Math.min(options.maxTokens ?? selected.maxTokens, selected.maxTokens), ...(tools.length ? { tools } : {}) };
        const response = await fetch(`${selected.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(payload), signal: options.signal, redirect: 'error' });
        if (!response.ok || !response.body) throw new Error(`Local model HTTP ${response.status}.`);
        events.push({ type: 'start', partial: message });
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let buffer = ''; let totalBytes = 0; let ended = false; let finished = false;
        const calls = new Map<number, { contentIndex: number; json: string }>();
        let textIndex: number | undefined;
        const consume = (frame: string) => {
          const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!raw) return;
          if (raw === '[DONE]') { ended = true; return; }
          const chunk = JSON.parse(raw) as { id?: string; choices?: Array<{ index?: number; finish_reason?: string | null; delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
          if (chunk.id) message.responseId = chunk.id;
          if (chunk.usage) {
            for (const value of [chunk.usage.prompt_tokens, chunk.usage.completion_tokens, chunk.usage.total_tokens]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid local model usage.');
            message.usage.input = chunk.usage.prompt_tokens ?? 0; message.usage.output = chunk.usage.completion_tokens ?? 0; message.usage.totalTokens = chunk.usage.total_tokens ?? message.usage.input + message.usage.output;
            REPORTED_USAGE.set(message.usage, { inputTokens: chunk.usage.prompt_tokens ?? null, outputTokens: chunk.usage.completion_tokens ?? null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: chunk.usage.total_tokens ?? null, costUsd: null });
          }
          for (const choice of chunk.choices ?? []) {
            if ((choice.index ?? 0) !== 0) continue;
            if (choice.finish_reason) {
              if (!['stop', 'length', 'tool_calls'].includes(choice.finish_reason)) throw new Error('Unsupported local model stop reason.');
              finished = true; message.stopReason = choice.finish_reason === 'tool_calls' ? 'toolUse' : choice.finish_reason === 'length' ? 'length' : 'stop';
            }
            const delta = choice.delta;
            if (typeof delta?.content === 'string' && delta.content) {
              if (textIndex === undefined) { textIndex = message.content.length; message.content.push({ type: 'text', text: '' }); events.push({ type: 'text_start', contentIndex: textIndex, partial: message }); }
              const part = message.content[textIndex]; if (part.type !== 'text') throw new Error('Invalid local model text state.');
              part.text += delta.content; events.push({ type: 'text_delta', contentIndex: textIndex, delta: delta.content, partial: message });
            }
            for (const call of delta?.tool_calls ?? []) {
              if (!Number.isSafeInteger(call.index) || call.index < 0 || call.index >= 32) throw new Error('Too many local model tool calls.');
              let active = calls.get(call.index);
              if (!active) { active = { contentIndex: message.content.length, json: '' }; calls.set(call.index, active); message.content.push({ type: 'toolCall', id: call.id ?? '', name: '', arguments: {} }); events.push({ type: 'toolcall_start', contentIndex: active.contentIndex, partial: message }); }
              const part = message.content[active.contentIndex]; if (part.type !== 'toolCall') throw new Error('Invalid local model tool state.');
              if (call.id) part.id = call.id;
              if (call.function?.name) part.name += call.function.name;
              if (call.function?.arguments) { active.json += call.function.arguments; events.push({ type: 'toolcall_delta', contentIndex: active.contentIndex, delta: call.function.arguments, partial: message }); }
            }
          }
        };
        while (!ended) {
          const next = await reader.read();
          if (next.done) { buffer += decoder.decode(); break; }
          totalBytes += next.value.byteLength;
          if (totalBytes > 4 * 1024 * 1024) throw new Error('Local model stream exceeds the response budget.');
          buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n');
          let split: number;
          while ((split = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2); consume(frame); }
        }
        if (!ended || !finished || (message.stopReason === 'toolUse') !== Boolean(calls.size)) throw new Error('Local model stream ended without a completed protocol response.');
        if (textIndex !== undefined) { const part = message.content[textIndex]; if (part.type === 'text') events.push({ type: 'text_end', contentIndex: textIndex, content: part.text, partial: message }); }
        for (const active of calls.values()) {
          const part = message.content[active.contentIndex]; if (part.type !== 'toolCall' || !part.id || !part.name) throw new Error('Incomplete local model tool call.');
          const params: unknown = JSON.parse(active.json || '{}');
          if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid local model tool arguments.');
          part.arguments = params as ToolCall['arguments']; events.push({ type: 'toolcall_end', contentIndex: active.contentIndex, toolCall: part, partial: message });
        }
        events.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
      } catch (error) {
        message.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        message.errorMessage = options.signal?.aborted ? 'Local model request cancelled.' : error instanceof Error && /^Local model HTTP \d+\.$/.test(error.message) ? error.message : 'Local model returned an invalid or interrupted streaming response.';
        events.push({ type: 'error', reason: message.stopReason, error: message });
      } finally { await reader?.cancel().catch(() => undefined); events.end(); }
    })();
    return events;
  };
  return { id: model.provider, name: 'Admin-configured local model', baseUrl: model.baseUrl, auth: { apiKey: { name: apiKey ? 'Encrypted PineTerm API key' : 'Explicit local no-auth', check: async () => ({ type: 'api_key', source: 'admin-selected local configuration' }), resolve: async () => ({ auth: apiKey ? { apiKey } : {}, source: 'admin-selected local configuration' }) } }, getModels: () => [model], stream, streamSimple: stream };
}
