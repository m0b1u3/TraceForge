const METHOD_TONES = new Set(["get", "post", "put", "patch", "delete"]);

export function MethodBadge({ method }: { method: string }) {
  const normalized = method.toLowerCase();
  const tone = METHOD_TONES.has(normalized) ? normalized : "other";
  return <span className={`method ${tone}`}>{method}</span>;
}
