import { describe, expect, it } from "vite-plus/test";

import {
  localModelBaseUrl,
  localModelInstance,
  localModelRuntimeConfig,
  localModelSlug,
} from "./localModel";

const local = {
  baseUrl: "http://localhost:11434",
  modelId: "local-community/coder:8b",
  label: "Local coder",
  toolCalling: false,
};

describe("local model picker configuration", () => {
  it("routes a saved choice only to the specified local model", () => {
    const result = localModelRuntimeConfig(local);
    expect(result.enabled_providers).toEqual(["screddy-local"]);
    expect(result.agent).toEqual({
      build: { tools: { "*": false } },
      plan: { tools: { "*": false } },
    });
    expect(localModelRuntimeConfig({ ...local, toolCalling: true }).agent).toBeUndefined();
    expect(result.model).toBe("screddy-local/local-community/coder:8b");
    expect(result.provider["screddy-local"].options.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(result.provider["screddy-local"].models[local.modelId]?.tool_call).toBe(false);
    expect(
      localModelRuntimeConfig({ ...local, toolCalling: true }).provider["screddy-local"].models[
        local.modelId
      ]?.tool_call,
    ).toBe(true);
  });

  it("uses one registration identity for a model across equivalent loopback URLs", async () => {
    const saved = await localModelInstance(local);
    const equivalent = await localModelInstance({
      ...local,
      baseUrl: "http://127.0.0.1:11434/v1/",
    });
    const differentModel = await localModelInstance({ ...local, modelId: "local-other" });
    expect(saved.instanceId).toBe(equivalent.instanceId);
    expect(differentModel.instanceId).not.toBe(saved.instanceId);
    expect(saved.instance.driver).toBe("opencode");
  });

  it.each([
    "qwen3.5:4b-256k",
    "qwen3.5:4b",
    "qwen3.8:27b-obliterated",
    "hf.co/OBLITERATUS/Qwen3.8-27B-OBLITERATED:Q4_K_M",
    "nomic-embed-text:latest",
  ])("rejects unsuitable local model %s", (modelId) => {
    expect(() => localModelSlug(modelId)).toThrow();
  });

  it.each([
    "https://remote.example/v1",
    "http://127.0.0.1.example:11434/v1",
    "http://user:secret@127.0.0.1:11434/v1",
    "http://127.0.0.1:11434/other",
  ])("rejects an out-of-scope endpoint", (url) => {
    expect(() => localModelBaseUrl(url)).toThrow();
  });
});
