import { useEffect, useState } from "react";
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
  const [jsonMode, setJsonMode] = useState("");
  const [contextWindowTokens, setContextWindowTokens] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{
    status: "idle" | "testing" | "ok" | "error";
    message?: string;
  }>({ status: "idle" });

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
    setContextWindowTokens(
      llmConfig.contextWindowTokens ? String(llmConfig.contextWindowTokens) : ""
    );
    setMaxOutputTokens(
      llmConfig.maxOutputTokens ? String(llmConfig.maxOutputTokens) : ""
    );
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
    contextWindowTokens: contextWindowTokens
      ? Number(contextWindowTokens)
      : undefined,
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
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure the LLM endpoint used by the agent.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-5">
          <div className="grid gap-4">
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
                >
                  {showApiKey ? "Hide" : "Show"}
                </Button>
              </div>
            </div>

            <div className="grid gap-2">
              <label htmlFor="baseUrl" className="text-sm font-medium">
                Base URL
              </label>
              <div className="flex gap-2">
                <Input
                  id="baseUrl"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.example.com"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setBaseUrl(PROVIDER_DEFAULT_BASE_URLS[provider])
                  }
                >
                  Use LongCat default
                </Button>
              </div>
            </div>

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
              <div className="flex items-start gap-2 text-sm">
                <Badge
                  variant={
                    testStatus.status === "ok" ? "default" : "destructive"
                  }
                >
                  {testStatus.status === "ok" ? "Connected" : "Error"}
                </Badge>
                <span className="text-muted-foreground">
                  {testStatus.message}
                </span>
              </div>
            )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
