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

const PROVIDER_DEFAULT_BASE_URLS: Record<LlmConfigInput["provider"], string> = {
  openai: "https://api.longcat.chat/openai",
  anthropic: "https://api.longcat.chat/anthropic",
};

export interface SettingsModalProps {
  open?: boolean;
  initialConfig?: LlmConfig | null;
}

export function SettingsModal({
  open,
  initialConfig,
}: SettingsModalProps = {}) {
  const {
    settingsModalOpen, setSettingsModalOpen, llmConfig: storeConfig, loadLlmConfig, saveLlmConfig, testLlmConfig,
  } = useStore();

  const settingsModalOpen_ = open ?? settingsModalOpen;
  const llmConfig = initialConfig ?? storeConfig;

  const [provider, setProvider] = useState<LlmConfigInput["provider"]>("openai");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [jsonMode, setJsonMode] = useState("");
  const [contextWindowTokens, setContextWindowTokens] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{ status: "idle" | "testing" | "ok" | "error"; message?: string }>({ status: "idle" });

  useEffect(() => {
    if (settingsModalOpen_) {
      loadLlmConfig();
      setShowApiKey(false);
      setTestStatus({ status: "idle" });
    }
  }, [settingsModalOpen_, loadLlmConfig]);

  useEffect(() => {
    if (!llmConfig) return;
    setProvider(llmConfig.provider);
    setModel(llmConfig.model);
    setBaseUrl(llmConfig.baseUrl ?? "");
    setJsonMode(llmConfig.jsonMode ?? "");
    setContextWindowTokens(llmConfig.contextWindowTokens ? String(llmConfig.contextWindowTokens) : "");
    setMaxOutputTokens(llmConfig.maxOutputTokens ? String(llmConfig.maxOutputTokens) : "");
  }, [llmConfig]);

  useEffect(() => {
    if (!baseUrl) {
      setBaseUrl(PROVIDER_DEFAULT_BASE_URLS[provider]);
    }
  }, [provider]);

  if (!settingsModalOpen_) return null;

  const buildInput = (): LlmConfigInput => ({
    provider,
    model,
    baseUrl: baseUrl || undefined,
    apiKey: apiKey || undefined,
    jsonMode: jsonMode ? (jsonMode as LlmConfigInput["jsonMode"]) : undefined,
    contextWindowTokens: contextWindowTokens ? Number(contextWindowTokens) : undefined,
    maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : undefined,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await saveLlmConfig(buildInput());
      setSettingsModalOpen(false);
      setApiKey("");
      setTestStatus({ status: "idle" });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (testing || !model.trim()) return;
    setTesting(true);
    setTestStatus({ status: "testing" });
    try {
      const result = await testLlmConfig(buildInput());
      setTestStatus({ status: result.ok ? "ok" : "error", message: result.message || result.error });
    } finally {
      setTesting(false);
    }
  };

  const testStatusClass = testStatus.status === "ok" ? "test-status-ok" : testStatus.status === "error" ? "test-status-error" : "";

  return (
    <div className="tf-modal-bg">
      <div className="tf-modal settings-modal">
        <div className="panel-header graph-modal-header">
          <h2>Settings</h2>
          <button type="button" className="tf-btn" onClick={() => setSettingsModalOpen(false)}>Close</button>
        </div>
        <form onSubmit={handleSubmit} className="settings-form">
          <div className="settings-body">
            <div className="settings-fields">
              <label>
                <span>Provider</span>
                <Select value={provider} options={PROVIDERS} onChange={(v) => setProvider(v as LlmConfigInput["provider"])} />
              </label>
              <label>
                <span>Model</span>
                <input className="tf-input tf-input-block" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. LongCat-2.0" />
              </label>
              <label>
                <span>API Key</span>
                <div className="settings-input-row">
                  <input
                    className="tf-input tf-input-block"
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={llmConfig?.apiKeyMasked ? "Configured" : "Enter API key"}
                  />
                  <button
                    type="button"
                    className="tf-btn"
                    onClick={() => setShowApiKey((v) => !v)}
                  >
                    {showApiKey ? "Hide" : "Show"}
                  </button>
                </div>
              </label>
              <label>
                <span>Base URL</span>
                <div className="settings-input-row">
                  <input className="tf-input tf-input-block" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
                  <button
                    type="button"
                    className="tf-btn"
                    onClick={() => setBaseUrl(PROVIDER_DEFAULT_BASE_URLS[provider])}
                  >
                    Use LongCat default
                  </button>
                </div>
              </label>
              <label>
                <span>JSON Mode</span>
                <Select value={jsonMode} options={JSON_MODES} onChange={setJsonMode} />
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
          </div>

          <div className="settings-footer">
            <button type="button" className="tf-btn" onClick={handleTest} disabled={testing || saving || !model.trim()}>
              {testing ? "Testing..." : "Test Connection"}
            </button>
            <div className="settings-footer-actions">
              <button type="button" className="tf-btn" onClick={() => setSettingsModalOpen(false)} disabled={saving || testing}>Cancel</button>
              <button type="submit" className="tf-btn tf-btn-primary" disabled={saving || testing || !model.trim()}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
          {testStatus.status !== "idle" && testStatus.status !== "testing" && testStatus.message && (
            <div className={`test-status ${testStatusClass}`}>{testStatus.message}</div>
          )}
        </form>
      </div>
    </div>
  );
}
