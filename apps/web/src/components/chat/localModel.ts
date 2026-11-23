import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

const LOCAL_MODEL_PROVIDER = "screddy-local";
export const LOCAL_MODEL_DRIVER = ProviderDriverKind.make("opencode");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function localModelBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a local server URL such as http://127.0.0.1:11434/v1.");
  }
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/v1", "/v1/"].includes(url.pathname)
  ) {
    throw new Error("Use a loopback HTTP server URL on this Mac, with /v1 or no path.");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return `${url.origin}/v1`;
}

export function localModelSlug(input: string): string {
  const id = input.trim();
  if (
    !/^[a-zA-Z0-9][\w.:-]*(?:\/[a-zA-Z0-9][\w.:-]*)*$/.test(id) ||
    id.length > 160 ||
    id.split("/").some((segment) => /^(?:constructor|prototype|__proto__)$/i.test(segment))
  ) {
    throw new Error("Enter the exact model ID reported by your local server.");
  }
  const lower = id.toLowerCase();
  if (
    /(?:^|\/)qwen3\.5(?::4b(?:[-_][\w.]+)?|[-_]4b(?:[-_:/][\w.:/-]+)?)(?:$|\/)/i.test(lower) ||
    /(?:^|\/)qwen3\.8[-_:](?:27b[-_:])?obliterated(?:$|[-_:/])/.test(lower)
  ) {
    throw new Error("This Qwen model is reserved for standalone terminal use.");
  }
  if (/(?:^|[/:_-])(?:embed|embedding|embeddings)(?:$|[/:_.-])/.test(lower)) {
    throw new Error("Choose a chat model. Embedding models cannot answer a conversation.");
  }
  return id;
}

export interface LocalModelInput {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly label: string;
  readonly toolCalling: boolean;
}

export function localModelRuntimeConfig(input: LocalModelInput) {
  const baseURL = localModelBaseUrl(input.baseUrl);
  const modelID = localModelSlug(input.modelId);
  const name = input.label.trim().slice(0, 70) || modelID;
  return {
    model: `${LOCAL_MODEL_PROVIDER}/${modelID}`,
    small_model: `${LOCAL_MODEL_PROVIDER}/${modelID}`,
    enabled_providers: [LOCAL_MODEL_PROVIDER],
    // OpenCode v1 still advertises tools when the model capability is false.
    ...(input.toolCalling
      ? {}
      : {
          agent: { build: { tools: { "*": false } }, plan: { tools: { "*": false } } },
        }),
    provider: {
      [LOCAL_MODEL_PROVIDER]: {
        name: "Local models",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL, apiKey: "local" },
        models: {
          [modelID]: {
            name,
            tool_call: input.toolCalling,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 8_192, output: 2_048 },
          },
        },
      },
    },
  };
}

export async function localModelInstance(input: LocalModelInput): Promise<{
  instanceId: ProviderInstanceId;
  instance: ProviderInstanceConfig;
}> {
  const config = localModelRuntimeConfig(input);
  const modelID = localModelSlug(input.modelId);
  const label = input.label.trim().slice(0, 70) || modelID;
  const identity = `${localModelBaseUrl(input.baseUrl)}\n${modelID}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const key = [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    instanceId: ProviderInstanceId.make(`screddy-local-${key}`),
    instance: {
      driver: LOCAL_MODEL_DRIVER,
      displayName: `Local · ${label}`,
      enabled: true,
      environment: [
        { name: "OPENCODE_CONFIG_CONTENT", value: JSON.stringify(config), sensitive: false },
        { name: "OPENCODE_DISABLE_PROJECT_CONFIG", value: "1", sensitive: false },
        { name: "OPENCODE_DISABLE_DEFAULT_PLUGINS", value: "1", sensitive: false },
        { name: "OPENCODE_DISABLE_MODELS_FETCH", value: "1", sensitive: false },
      ],
    },
  };
}
