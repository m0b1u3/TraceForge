import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { Select } from "./Select.js";
import type { LlmConfigInput, LlmConfig } from "../api.js";

const PROVIDERS = [
  { value: "openai", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
];

const JSON_MODES = [
  { value: "", label: "Default" },
  { value: "json_schema", label: "JSON Schema" },
  { value: "json_object", label: "JSON Object" },
];

export interface SettingsModalProps {
  open?: boolean;
  initialConfig?: LlmConfig | null;
}

export function SettingsModal({
  open,
  initialConfig,
}: SettingsModalProps = {}) {
  const {
    settingsModalOpen, setSettingsModalOpen, llmConfig: storeConfig, loadLlmConfig, saveLlmConfig,
  } = useStore();

  const settingsModalOpen_ = open ?? settingsModalOpen;
  const llmConfig = initialConfig ?? storeConfig;

  const [tab, setTab] = useState<"basic" | "advanced">("basic");
  const [provider, setProvider] = useState<LlmConfigInput["provider"]>("openai");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [jsonMode, setJsonMode] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [contextWindowTokens, setContextWindowTokens] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settingsModalOpen_) {
      loadLlmConfig();
      setTab("basic");
    }
  }, [settingsModalOpen_, loadLlmConfig]);

  useEffect(() => {
    if (!llmConfig) return;
    setProvider(llmConfig.provider);
    setModel(llmConfig.model);
    setBaseUrl(llmConfig.baseUrl ?? "");
    setJsonMode(llmConfig.jsonMode ?? "");
    setApiKeyEnv(llmConfig.apiKeyEnv ?? "");
    setContextWindowTokens(llmConfig.contextWindowTokens ? String(llmConfig.contextWindowTokens) : "");
    setMaxOutputTokens(llmConfig.maxOutputTokens ? String(llmConfig.maxOutputTokens) : "");
  }, [llmConfig]);

  if (!settingsModalOpen_) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await saveLlmConfig({
        provider,
        model,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
        jsonMode: jsonMode ? (jsonMode as LlmConfigInput["jsonMode"]) : undefined,
        apiKeyEnv: apiKeyEnv || undefined,
        contextWindowTokens: contextWindowTokens ? Number(contextWindowTokens) : undefined,
        maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : undefined,
      });
      setSettingsModalOpen(false);
      setApiKey("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tf-modal-bg" onClick={() => setSettingsModalOpen(false)}>
      <div className="tf-modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header graph-modal-header">
          <h2>Settings</h2>
          <button type="button" className="tf-btn" onClick={() => setSettingsModalOpen(false)}>Close</button>
        </div>
        <form onSubmit={handleSubmit} className="settings-form">
          <div className="tf-tabs">
            <button type="button" className={`tf-tab ${tab === "basic" ? "active" : ""}`} onClick={() => setTab("basic")}>Basic</button>
            <button type="button" className={`tf-tab ${tab === "advanced" ? "active" : ""}`} onClick={() => setTab("advanced")}>Advanced</button>
          </div>

          <div className="settings-body">
            {tab === "basic" && (
              <div className="settings-fields">
                <label>
                  <span>Provider</span>
                  <Select value={provider} options={PROVIDERS} onChange={(v) => setProvider(v as LlmConfigInput["provider"])} />
                </label>
                <label>
                  <span>Model</span>
                  <input className="tf-input tf-input-block" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. deepseek-v4-flash" />
                </label>
                <label>
                  <span>API Key</span>
                  <input
                    className="tf-input tf-input-block"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={llmConfig?.apiKeyMasked ? "Configured" : "Enter API key"}
                  />
                  {llmConfig?.apiKeyEnv && <small className="settings-hint">Stored in environment variable: {llmConfig.apiKeyEnv}</small>}
                </label>
              </div>
            )}

            {tab === "advanced" && (
              <div className="settings-fields">
                <label>
                  <span>Base URL</span>
                  <input className="tf-input tf-input-block" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
                </label>
                <label>
                  <span>JSON Mode</span>
                  <Select value={jsonMode} options={JSON_MODES} onChange={setJsonMode} />
                </label>
                <label>
                  <span>Environment Variable Name</span>
                  <input className="tf-input tf-input-block" value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder="AUTO if left empty" />
                </label>
                <label>
                  <span>Context Window Tokens</span>
                  <input className="tf-input tf-input-block" inputMode="numeric" value={contextWindowTokens} onChange={(e) => setContextWindowTokens(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 128000" />
                </label>
                <label>
                  <span>Max Output Tokens</span>
                  <input className="tf-input tf-input-block" inputMode="numeric" value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 8192" />
                </label>
              </div>
            )}
          </div>

          <div className="settings-footer">
            <button type="submit" className="tf-btn tf-btn-primary" disabled={saving || !model.trim()}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
