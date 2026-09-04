import { useEffect, useState } from "react";
import { CheckCircle, CircleNotch, Cpu, Eye, EyeSlash, Moon, Palette, SlidersHorizontal, Sun, Warning } from "@phosphor-icons/react";
import { useStore } from "../store.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type LlmConfigInput, type LlmConfig } from "../api.js";
import { useShallow } from "zustand/react/shallow";
import { useAppTheme } from "../hooks/useAppTheme.js";

const PROVIDERS = [
  { value: "openai", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
];

const JSON_MODES = [
  { value: "default", label: "Default" },
  { value: "json_schema", label: "JSON Schema" },
  { value: "json_object", label: "JSON Object" },
];

const CURRENCIES = ["USD", "CNY", "EUR", "GBP", "JPY"];

function DesktopUpdateSettings() {
  const bridge = globalThis.window?.traceforgeDesktop;
  const [state, setState] = useState<{ status?: string; version?: string; percent?: number; message?: string }>({ status: "idle" });
  useEffect(() => bridge?.onUpdateState(setState), [bridge]);
  if (!bridge) return null;
  return <section className="settings-section">
    <div className="settings-section-heading"><strong>Desktop updates</strong><span>Signed release metadata is checked without downloading until you approve.</span></div>
    <div className="settings-key-status" role="status">{state.status === "downloading" ? `Downloading ${Math.round(state.percent ?? 0)}%` : state.status === "available" ? `Version ${state.version} is available` : state.status === "ready" ? `Version ${state.version} is ready to install` : state.message ?? state.status}</div>
    <div className="flex gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void bridge.checkForUpdates()}>Check for updates</Button>
      {state.status === "available" && <Button type="button" size="sm" onClick={() => void bridge.downloadUpdate()}>Download</Button>}
      {state.status === "ready" && <Button type="button" size="sm" onClick={() => void bridge.installUpdate()}>Restart and install</Button>}
    </div>
  </section>;
}

export interface LlmSettingsFields {
  provider: LlmConfigInput["provider"];
  model: string;
  embeddingModel?: string;
  apiKey: string;
  baseUrl: string;
  jsonMode: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
  currency: string;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
}

export function buildLlmConfigInput(fields: LlmSettingsFields): LlmConfigInput {
  return {
    provider: fields.provider,
    model: fields.model.trim(),
    ...(fields.embeddingModel?.trim() ? { embeddingModel: fields.embeddingModel.trim() } : {}),
    baseUrl: fields.baseUrl.trim() || undefined,
    apiKey: fields.apiKey || undefined,
    jsonMode: fields.jsonMode === "default" ? undefined : (fields.jsonMode as LlmConfigInput["jsonMode"]),
    contextWindowTokens: fields.contextWindowTokens ? Number(fields.contextWindowTokens) : undefined,
    maxOutputTokens: fields.maxOutputTokens ? Number(fields.maxOutputTokens) : undefined,
    currency: fields.currency || null,
    inputPricePerMillion: fields.inputPricePerMillion ? Number(fields.inputPricePerMillion) : null,
    outputPricePerMillion: fields.outputPricePerMillion ? Number(fields.outputPricePerMillion) : null,
  };
}

export function validateLlmSettings(input: LlmConfigInput): string | null {
  if (!input.model.trim()) return "Model is required.";
  if (input.contextWindowTokens && input.maxOutputTokens && input.maxOutputTokens >= input.contextWindowTokens) {
    return "Max output tokens must be smaller than the context window.";
  }
  const pricing = [input.currency, input.inputPricePerMillion, input.outputPricePerMillion];
  const configuredPricingFields = pricing.filter((value) => value !== null && value !== undefined).length;
  if (configuredPricingFields !== 0 && configuredPricingFields !== pricing.length) {
    return "Currency and both token prices are required to calculate cost.";
  }
  if ((input.inputPricePerMillion ?? 0) < 0 || (input.outputPricePerMillion ?? 0) < 0) {
    return "Token prices cannot be negative.";
  }
  if (
    (input.inputPricePerMillion !== null && input.inputPricePerMillion !== undefined && !Number.isFinite(input.inputPricePerMillion))
    || (input.outputPricePerMillion !== null && input.outputPricePerMillion !== undefined && !Number.isFinite(input.outputPricePerMillion))
  ) {
    return "Token prices must be valid numbers.";
  }
  return null;
}

export interface SettingsModalProps {
  open?: boolean;
  initialConfig?: LlmConfig | null;
}

export function SettingsModal({
  open,
  initialConfig,
}: SettingsModalProps = {}) {
  const {
    settingsModalOpen,
    setSettingsModalOpen,
    llmConfig: storeConfig,
    loadLlmConfig,
    saveLlmConfig,
    testLlmConfig,
  } = useStore(useShallow((state) => ({
    settingsModalOpen: state.settingsModalOpen,
    setSettingsModalOpen: state.setSettingsModalOpen,
    llmConfig: state.llmConfig,
    loadLlmConfig: state.loadLlmConfig,
    saveLlmConfig: state.saveLlmConfig,
    testLlmConfig: state.testLlmConfig,
  })));

  const settingsModalOpen_ = open ?? settingsModalOpen;
  const llmConfig = initialConfig ?? storeConfig;

  const [provider, setProvider] = useState<LlmConfigInput["provider"]>("openai");
  const [model, setModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [jsonMode, setJsonMode] = useState("default");
  const [contextWindowTokens, setContextWindowTokens] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [currency, setCurrency] = useState("");
  const [inputPricePerMillion, setInputPricePerMillion] = useState("");
  const [outputPricePerMillion, setOutputPricePerMillion] = useState("");
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<{
    status: "idle" | "testing" | "ok" | "error";
    message?: string;
  }>({ status: "idle" });
  const [activeSection, setActiveSection] = useState<"model" | "runtime" | "interface">("model");
  const { theme, setTheme } = useAppTheme();

  useEffect(() => {
    if (settingsModalOpen_) {
      if (!initialConfig) void loadLlmConfig();
      setShowApiKey(false);
      setTestStatus({ status: "idle" });
      setFormError(null);
      setActiveSection("model");
    }
  }, [settingsModalOpen_, initialConfig, loadLlmConfig]);

  useEffect(() => {
    if (!llmConfig) return;
    setProvider(llmConfig.provider);
    setModel(llmConfig.model);
    setEmbeddingModel(llmConfig.embeddingModel ?? "");
    setApiKey(llmConfig.apiKeyMasked ?? "");
    setApiKeyDirty(false);
    setShowApiKey(false);
    setBaseUrl(llmConfig.baseUrl ?? "");
    setJsonMode(llmConfig.jsonMode ?? "default");
    setContextWindowTokens(
      llmConfig.contextWindowTokens ? String(llmConfig.contextWindowTokens) : ""
    );
    setMaxOutputTokens(
      llmConfig.maxOutputTokens ? String(llmConfig.maxOutputTokens) : ""
    );
    setCurrency(llmConfig.currency ?? "");
    setInputPricePerMillion(llmConfig.inputPricePerMillion === undefined ? "" : String(llmConfig.inputPricePerMillion));
    setOutputPricePerMillion(llmConfig.outputPricePerMillion === undefined ? "" : String(llmConfig.outputPricePerMillion));
  }, [llmConfig]);

  if (!settingsModalOpen_) return null;

  const buildInput = () => buildLlmConfigInput({ provider, model, embeddingModel, apiKey: apiKeyDirty ? apiKey : "", baseUrl, jsonMode, contextWindowTokens, maxOutputTokens, currency, inputPricePerMillion, outputPricePerMillion });

  const isDirty = Boolean(llmConfig && (
    provider !== llmConfig.provider
    || model !== llmConfig.model
    || embeddingModel !== (llmConfig.embeddingModel ?? "")
    || apiKeyDirty
    || baseUrl !== (llmConfig.baseUrl ?? "")
    || jsonMode !== (llmConfig.jsonMode ?? "default")
    || contextWindowTokens !== (llmConfig.contextWindowTokens ? String(llmConfig.contextWindowTokens) : "")
    || maxOutputTokens !== (llmConfig.maxOutputTokens ? String(llmConfig.maxOutputTokens) : "")
    || currency !== (llmConfig.currency ?? "")
    || inputPricePerMillion !== (llmConfig.inputPricePerMillion === undefined ? "" : String(llmConfig.inputPricePerMillion))
    || outputPricePerMillion !== (llmConfig.outputPricePerMillion === undefined ? "" : String(llmConfig.outputPricePerMillion))
  ));

  const requestClose = () => {
    if (isDirty && !globalThis.confirm("Discard unsaved settings changes?")) return;
    setShowApiKey(false);
    setApiKey(llmConfig?.apiKeyMasked ?? "");
    setSettingsModalOpen(false);
  };

  const toggleApiKeyVisibility = () => {
    if (showApiKey) {
      setShowApiKey(false);
      if (!apiKeyDirty) setApiKey(llmConfig?.apiKeyMasked ?? "");
      return;
    }
    if (apiKeyDirty) setShowApiKey(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = buildInput();
    const validationError = validateLlmSettings(input);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await saveLlmConfig(input);
      setSettingsModalOpen(false);
      setApiKey("");
      setShowApiKey(false);
      setTestStatus({ status: "idle" });
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const input = buildInput();
    const validationError = validateLlmSettings(input);
    if (testing || validationError) {
      if (validationError) setFormError(validationError);
      return;
    }
    setTesting(true);
    setFormError(null);
    setTestStatus({ status: "testing" });
    try {
      const result = await testLlmConfig(input);
      setTestStatus({
        status: result.ok ? "ok" : "error",
        message: result.message || result.error,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={settingsModalOpen_} onOpenChange={(nextOpen) => { if (!nextOpen) requestClose(); }}>
      <DialogContent className="settings-dialog" showCloseButton={false}>
        <DialogHeader className="settings-header">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure the LLM endpoint used by the agent.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <button type="button" className={activeSection === "model" ? "is-active" : ""} onClick={() => setActiveSection("model")}><Cpu size={17} /><span><strong>Model</strong><small>Provider and credentials</small></span></button>
            <button type="button" className={activeSection === "runtime" ? "is-active" : ""} onClick={() => setActiveSection("runtime")}><SlidersHorizontal size={17} /><span><strong>Runtime</strong><small>Context and pricing</small></span></button>
            <button type="button" className={activeSection === "interface" ? "is-active" : ""} onClick={() => setActiveSection("interface")}><Palette size={17} /><span><strong>Interface</strong><small>Appearance preferences</small></span></button>
          </nav>
          <div className="settings-content">
          {activeSection === "model" && <section className="settings-section" aria-labelledby="settings-model-title">
            <div className="settings-section-heading"><strong id="settings-model-title">Connection</strong><span>Endpoint and credentials used for every real Agent request.</span></div>
            <div className="grid gap-2">
              <label htmlFor="provider" className="text-sm font-medium">
                Provider
              </label>
              <Select
                value={provider}
                onValueChange={(v) =>
                  setProvider(v as LlmConfigInput["provider"])
                }
              >
                <SelectTrigger id="provider" className="w-full">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <label htmlFor="model" className="text-sm font-medium">
                Model
              </label>
              <Input
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. LongCat-2.0"
              />
            </div>

            <div className="grid gap-2">
              <label htmlFor="apiKey" className="text-sm font-medium">
                API Key
              </label>
              <div className="flex gap-2">
                <Input
                  id="apiKey"
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onFocus={() => {
                    if (!apiKeyDirty && !showApiKey && llmConfig?.apiKeyMasked) setApiKey("");
                  }}
                  onBlur={() => {
                    if (!apiKeyDirty && !showApiKey && llmConfig?.apiKeyMasked) setApiKey(llmConfig.apiKeyMasked);
                  }}
                  onChange={(e) => {
                    setApiKeyDirty(true);
                    setApiKey(e.target.value);
                  }}
                  placeholder={
                    llmConfig?.apiKeyMasked ? "Enter a replacement key" : "Enter API key"
                  }
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={toggleApiKeyVisibility}
                  disabled={!apiKeyDirty}
                  aria-label={showApiKey ? "Hide newly entered API key" : "Show newly entered API key"}
                  title={showApiKey ? "Hide newly entered API key" : "Show newly entered API key"}
                >
                  {showApiKey ? <EyeSlash size={15} /> : <Eye size={15} />}
                </Button>
              </div>
              {llmConfig?.apiKeyMasked && !apiKeyDirty && (
                <div className="settings-key-status" role="status"><CheckCircle size={14} weight="fill" />Stored securely. Enter a replacement key to change it.</div>
              )}
            </div>

            <div className="grid gap-2">
              <label htmlFor="baseUrl" className="text-sm font-medium">
                Base URL
              </label>
              <Input
                id="baseUrl"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </div>

            <div className="grid gap-2">
              <label htmlFor="embeddingModel" className="text-sm font-medium">Embedding model</label>
              <Input
                id="embeddingModel"
                value={embeddingModel}
                onChange={(event) => setEmbeddingModel(event.target.value)}
                placeholder="e.g. text-embedding-3-small"
              />
              <small>Optional. Enables persisted vector retrieval; without it TraceForge keeps keyword retrieval as a reliable fallback.</small>
            </div>
          </section>}

          {activeSection === "runtime" && <section className="settings-section" aria-labelledby="settings-runtime-title">
            <div className="settings-section-heading"><strong id="settings-runtime-title">Context budget</strong><span>Optional limits used by context compression and model output.</span></div>
            <div className="grid gap-2">
              <label htmlFor="jsonMode" className="text-sm font-medium">
                JSON Mode
              </label>
              <Select value={jsonMode} onValueChange={setJsonMode}>
                <SelectTrigger id="jsonMode" className="w-full">
                  <SelectValue placeholder="Select JSON mode" />
                </SelectTrigger>
                <SelectContent>
                  {JSON_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <label
                htmlFor="contextWindowTokens"
                className="text-sm font-medium"
              >
                Context Window Tokens
              </label>
              <Input
                id="contextWindowTokens"
                inputMode="numeric"
                value={contextWindowTokens}
                onChange={(e) =>
                  setContextWindowTokens(e.target.value.replace(/\D/g, ""))
                }
                placeholder="e.g. 128000"
              />
            </div>

            <div className="grid gap-2">
              <label htmlFor="maxOutputTokens" className="text-sm font-medium">
                Max Output Tokens
              </label>
              <Input
                id="maxOutputTokens"
                inputMode="numeric"
                value={maxOutputTokens}
                onChange={(e) =>
                  setMaxOutputTokens(e.target.value.replace(/\D/g, ""))
                }
                placeholder="e.g. 8192"
              />
            </div>
          </section>}

          {activeSection === "runtime" && <section className="settings-section">
            <div className="settings-section-heading"><strong>Usage pricing</strong><span>Optional provider prices used to calculate an auditable cost snapshot for each LLM turn.</span></div>
            <div className="grid gap-2">
              <label htmlFor="currency" className="text-sm font-medium">Currency</label>
              <Select value={currency || undefined} onValueChange={setCurrency}>
                <SelectTrigger id="currency" className="w-full"><SelectValue placeholder="Not configured" /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <label htmlFor="inputPricePerMillion" className="text-sm font-medium">Input / 1M tokens</label>
                <Input id="inputPricePerMillion" inputMode="decimal" value={inputPricePerMillion} onChange={(e) => setInputPricePerMillion(e.target.value.replace(/[^\d.]/g, ""))} placeholder="e.g. 2.00" />
              </div>
              <div className="grid gap-2">
                <label htmlFor="outputPricePerMillion" className="text-sm font-medium">Output / 1M tokens</label>
                <Input id="outputPricePerMillion" inputMode="decimal" value={outputPricePerMillion} onChange={(e) => setOutputPricePerMillion(e.target.value.replace(/[^\d.]/g, ""))} placeholder="e.g. 8.00" />
              </div>
            </div>
            {(currency || inputPricePerMillion || outputPricePerMillion) && (
              <Button type="button" variant="ghost" size="sm" onClick={() => { setCurrency(""); setInputPricePerMillion(""); setOutputPricePerMillion(""); }}>
                Clear pricing
              </Button>
            )}
          </section>}

          {activeSection === "interface" && <section className="settings-section settings-interface">
            <div className="settings-section-heading"><strong>Appearance</strong><span>Choose the workbench theme. Technical code surfaces retain their optimized contrast.</span></div>
            <div className="settings-theme-options" role="radiogroup" aria-label="Color theme">
              <button type="button" role="radio" aria-checked={theme === "light"} className={theme === "light" ? "is-selected" : ""} onClick={() => setTheme("light")}><Sun size={18} /><span><strong>Light</strong><small>Laboratory paper</small></span><CheckCircle size={16} weight={theme === "light" ? "fill" : "regular"} /></button>
              <button type="button" role="radio" aria-checked={theme === "dark"} className={theme === "dark" ? "is-selected" : ""} onClick={() => setTheme("dark")}><Moon size={18} /><span><strong>Dark</strong><small>Low-light operations</small></span><CheckCircle size={16} weight={theme === "dark" ? "fill" : "regular"} /></button>
            </div>
          </section>}
          {activeSection === "interface" && <DesktopUpdateSettings />}

          {formError && <div className="settings-feedback is-error" role="alert"><Warning size={16} weight="fill" />{formError}</div>}

          {testStatus.status !== "idle" && testStatus.status !== "testing" && testStatus.message && (
            <div className={`settings-feedback ${testStatus.status === "ok" ? "is-success" : "is-error"}`} role={testStatus.status === "ok" ? "status" : "alert"}>
              {testStatus.status === "ok" ? <CheckCircle size={16} weight="fill" /> : <Warning size={16} weight="fill" />}
              <Badge variant={testStatus.status === "ok" ? "default" : "destructive"}>{testStatus.status === "ok" ? "Connected" : "Error"}</Badge>
              <span>{testStatus.message}</span>
            </div>
          )}
          </div>

          <DialogFooter className="settings-footer">
            <div className="settings-footer-context">
              {activeSection === "model" && <Button
                type="button"
                variant="secondary"
                onClick={handleTest}
                disabled={testing || saving || !model.trim()}
              >
                {testing ? "Testing..." : "Test Connection"}
              </Button>}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={requestClose}
                disabled={saving || testing}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving || testing || !model.trim() || !isDirty}
              >
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </DialogFooter>

        </form>
      </DialogContent>
    </Dialog>
  );
}
