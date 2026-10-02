import { chmodSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { ModelRuntime, createAgentSession, SessionManager, SettingsManager, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Api, CredentialStore, Model } from '@earendil-works/pi-ai';
import { AGENT_TOOL_NAMES, type AgentModelChoice, type UpdateAgentConfig } from '@pineterm/contracts';
import { ApiError } from '../errors.js';
import { EmptyResourceLoader, assertAnalysisTools, assertRestrictedSession } from './policy.js';
import { localModelProvider } from './local-model.js';

export const CLOUD_AGENT_PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'groq', 'xai', 'deepseek', 'openrouter'] as const;
const EMPTY_CREDENTIALS: CredentialStore = {
  read: async () => undefined, list: async () => [],
  modify: async () => { throw new Error('Persistent SDK credential writes are disabled.'); },
  delete: async () => { throw new Error('Persistent SDK credential writes are disabled.'); },
};
export interface AgentStorage { root: string; cwd: string; sessions: string; runtimeDir: string; authPath: string; modelsPath: string; modelsStorePath: string }
export function protectedAgentStorage(dataDir: string): AgentStorage {
  const root = join(dataDir, 'agent'); const cwd = join(root, 'cwd'); const sessions = join(root, 'sessions');
  for (const directory of [root, cwd, sessions]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Agent storage must be an app-owned directory, not a symlink.');
    chmodSync(directory, 0o700);
  }
  const runtimeDir = mkdtempSync(join(root, 'runtime-')); chmodSync(runtimeDir, 0o700);
  const authPath = join(runtimeDir, 'auth.json'); const modelsPath = join(runtimeDir, 'models.json'); const modelsStorePath = join(runtimeDir, 'models-store.json');
  for (const path of [authPath, modelsPath]) writeFileSync(path, '{}', { mode: 0o600, flag: 'wx' });
  return { root, cwd, sessions, runtimeDir, authPath, modelsPath, modelsStorePath };
}
export function parseAgentBaseUrl(value: string): { url: string; local: boolean } {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ApiError(400, 'INVALID_MODEL_URL', 'Provide an absolute model HTTP(S) base URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || value.length > 2048) throw new ApiError(400, 'INVALID_MODEL_URL', 'Model URL cannot contain credentials, query or fragment.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host === '::1' || (isIP(host) === 4 && (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host))) || (isIP(host) === 6 && /^(?:fc|fd)/i.test(host));
  if (parsed.protocol === 'http:' && !local) throw new ApiError(400, 'INVALID_MODEL_URL', 'Remote model endpoints require HTTPS; HTTP is allowed only for explicit local/private-address servers.');
  return { url: parsed.href.replace(/\/$/, ''), local };
}
export function validateAgentSelection(body: UpdateAgentConfig, catalog: readonly Model<Api>[]): { model: Model<Api>; known: boolean; baseUrl: string | null } {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(body.provider) || !body.model.trim() || body.model !== body.model.trim() || body.model.length > 200 || /[\x00-\x1f]/.test(body.model)) throw new ApiError(400, 'INVALID_MODEL', 'Select a provider and model ID.');
  if (body.apiKey !== undefined && (!body.apiKey.trim() || body.apiKey !== body.apiKey.trim() || Buffer.byteLength(body.apiKey) > 8192 || /[\x00-\x1f]/.test(body.apiKey))) throw new ApiError(400, 'INVALID_MODEL_KEY', 'API key must be nonempty, without whitespace or control characters.');
  const base = body.baseUrl ? parseAgentBaseUrl(body.baseUrl) : undefined;
  if (body.authMode === 'none' && (!base?.local || body.apiKey !== undefined)) throw new ApiError(400, 'LOCAL_NO_AUTH_REQUIRED', 'No-auth requires an explicitly configured local model base URL and no API key.');
  const existing = catalog.find(model => model.provider === body.provider && model.id === body.model);
  if (!base && (!existing || !CLOUD_AGENT_PROVIDERS.includes(body.provider as typeof CLOUD_AGENT_PROVIDERS[number]))) throw new ApiError(422, 'MODEL_NOT_SUPPORTED', 'Choose a pinned API-key cloud catalog model or explicitly configure a local OpenAI-compatible base URL.');
  if (base && !base.local) throw new ApiError(422, 'LOCAL_MODEL_REQUIRED', 'Custom model endpoints must be explicit local/private-address servers; cloud models use their pinned catalog endpoint.');
  if (!existing && (!body.contextWindow || !body.maxTokens)) throw new ApiError(400, 'LOCAL_MODEL_METADATA_REQUIRED', 'Unknown local models require explicit contextWindow and maxTokens metadata.');
  for (const value of [body.contextWindow, body.maxTokens]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_000_000)) throw new ApiError(400, 'INVALID_MODEL_METADATA', 'Model token limits must be positive integers up to 2,000,000.');
  if (existing && (body.contextWindow !== undefined || body.maxTokens !== undefined)) throw new ApiError(400, 'CATALOG_METADATA_FIXED', 'Known catalog models use their pinned token metadata; do not override it.');
  const contextWindow = existing?.contextWindow ?? body.contextWindow!; const maxTokens = existing?.maxTokens ?? body.maxTokens!;
  if (maxTokens > contextWindow) throw new ApiError(400, 'INVALID_MODEL_METADATA', 'maxTokens cannot exceed contextWindow.');
  const model: Model<Api> = base ? { id: body.model, name: existing?.name ?? body.model, provider: body.provider, api: 'openai-completions', baseUrl: base.url, reasoning: false, input: ['text'], cost: existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens } : existing!;
  return { model, known: Boolean(existing) && !base, baseUrl: base?.url ?? null };
}

/** Even availability checks cannot see ~/.pi, env credentials, commands or OAuth. */
export async function createIsolatedModelRuntime(storage: AgentStorage): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials: EMPTY_CREDENTIALS, authPath: storage.authPath, modelsPath: storage.modelsPath, modelsStorePath: storage.modelsStorePath, allowModelNetwork: false, refreshOnCreate: false });
  for (const provider of runtime.getProviders()) runtime.registerNativeProvider({ id: provider.id, name: provider.name, getModels: () => provider.getModels(), stream: (model, context, options) => provider.stream(model, context, options), streamSimple: (model, context, options) => provider.streamSimple(model, context, options), auth: { apiKey: { name: 'App-owned configuration only', check: async () => undefined, resolve: async () => undefined } } });
  return runtime;
}
export async function configureSelectedModel(runtime: ModelRuntime, model: Model<Api>, apiKey: string | undefined, noAuth: boolean): Promise<void> {
  if (noAuth || parseAgentBaseUrl(model.baseUrl).local) { runtime.registerNativeProvider(localModelProvider(model as Model<'openai-completions'>, apiKey)); if (apiKey) await runtime.setRuntimeApiKey(model.provider, apiKey); return; }
  const provider = runtime.getProvider(model.provider);
  if (!provider) throw new ApiError(422, 'MODEL_NOT_SUPPORTED', 'The selected provider is unavailable in the pinned SDK.');
  runtime.registerNativeProvider({ id: provider.id, name: provider.name, baseUrl: model.baseUrl, getModels: () => [model], stream: (selected, context, options) => provider.stream(selected, context, Object.assign({}, options, { apiKey, env: {} })), streamSimple: (selected, context, options) => provider.streamSimple(selected, context, { ...options, apiKey, env: {} }), auth: { apiKey: { name: 'Encrypted PineTerm API key', check: async () => apiKey ? { type: 'api_key', source: 'PineTerm encrypted configuration' } : undefined, resolve: async () => apiKey ? { auth: { apiKey }, source: 'PineTerm encrypted configuration' } : undefined } } });
  if (apiKey) await runtime.setRuntimeApiKey(model.provider, apiKey);
}
export function catalogModelChoices(catalog: readonly Model<Api>[]): AgentModelChoice[] {
  return catalog.filter(model => CLOUD_AGENT_PROVIDERS.includes(model.provider as typeof CLOUD_AGENT_PROVIDERS[number])).map(model => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens }));
}
export async function createRestrictedAgentSession(options: { storage: AgentStorage; runtime: ModelRuntime; model: Model<Api>; manager: SessionManager; tools: ToolDefinition[] }) {
  assertAnalysisTools(options.tools);
  const result = await createAgentSession({ cwd: options.storage.cwd, agentDir: options.storage.runtimeDir, modelRuntime: options.runtime, model: options.model, settingsManager: SettingsManager.inMemory({ defaultProvider: options.model.provider, defaultModel: options.model.id, defaultThinkingLevel: 'off', defaultTools: [...AGENT_TOOL_NAMES], compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120_000 } }, cacheWarming: 'off', enableSkillCommands: false, enableAnalytics: false, enableInstallTelemetry: false, packages: [], extensions: [], skills: [], prompts: [], themes: [], images: { blockImages: true }, defaultProjectTrust: 'never' }), sessionManager: options.manager, resourceLoader: new EmptyResourceLoader(), noTools: 'builtin', tools: [...AGENT_TOOL_NAMES], customTools: options.tools });
  try { assertRestrictedSession(result.session); } catch (error) { result.session.dispose(); throw error; }
  return result.session;
}
