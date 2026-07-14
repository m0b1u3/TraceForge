import { useEffect, useState } from "react";
import { CheckCircle, Eye, EyeSlash, WarningCircle } from "@phosphor-icons/react";
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
import type { LlmConfigInput, LlmConfig } from "../api.js";

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

export interface LlmSettingsFields {
  provider: LlmConfigInput["provider"];
  model: string;
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
  } = useStore();

  const settingsModalOpen_ = open ?? settingsModalOpen;
  const llmConfig = initialConfig ?? storeConfig;

  const [provider, setProvider] = useState<LlmConfigInput["provider"]>("openai");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
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

  useEffect(() => {
    if (settingsModalOpen_) {
      if (!initialConfig) void loadLlmConfig();
      setShowApiKey(false);
      setTestStatus({ status: "idle" });
      setFormError(null);
    }
  }, [settingsModalOpen_, initialConfig, loadLlmConfig]);

  useEffect(() => {
    if (!llmConfig) return;
    setProvider(llmConfig.provider);
    setModel(llmConfig.model);
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

  const buildInput = () => buildLlmConfigInput({ provider, model, apiKey, baseUrl, jsonMode, contextWindowTokens, maxOutputTokens, currency, inputPricePerMillion, outputPricePerMillion });

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
    <Dialog open={settingsModalOpen_} onOpenChange={setSettingsModalOpen}>
      <DialogContent className="settings-dialog sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure the LLM endpoint used by the agent.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-5">
          <div className="settings-section">
            <div className="settings-section-heading"><strong>Connection</strong><span>Endpoint and credentials used for every real Agent request.</span></div>
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
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    llmConfig?.apiKeyMasked ? "Configured" : "Enter API key"
                  }
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowApiKey((v) => !v)}
                  aria-label={showApiKey ? "Hide API key" : "Show API key"}
                  title={showApiKey ? "Hide API key" : "Show API key"}
                >
                  {showApiKey ? <EyeSlash size={15} /> : <Eye size={15} />}
                </Button>
              </div>
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
          </div>

          <div className="settings-section">
            <div className="settings-section-heading"><strong>Context budget</strong><span>Optional limits used by context compression and model output.</span></div>
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
          </div>

          <div className="settings-section">
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
          </div>

          {formError && <div className="settings-feedback is-error" role="alert"><WarningCircle size={16} weight="fill" />{formError}</div>}

          <DialogFooter className="justify-between gap-2 sm:justify-between">
            <Button
              type="button"
              variant="secondary"
              onClick={handleTest}
              disabled={testing || saving || !model.trim()}
            >
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setSettingsModalOpen(false)}
                disabled={saving || testing}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving || testing || !model.trim()}
              >
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </DialogFooter>

          {testStatus.status !== "idle" &&
            testStatus.status !== "testing" &&
            testStatus.message && (
              <div className={`settings-feedback ${testStatus.status === "ok" ? "is-success" : "is-error"}`} role={testStatus.status === "ok" ? "status" : "alert"}>
                {testStatus.status === "ok" ? <CheckCircle size={16} weight="fill" /> : <WarningCircle size={16} weight="fill" />}
                <Badge
                  variant={
                    testStatus.status === "ok" ? "default" : "destructive"
                  }
                >
                  {testStatus.status === "ok" ? "Connected" : "Error"}
                </Badge>
                <span>{testStatus.message}</span>
              </div>
            )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
