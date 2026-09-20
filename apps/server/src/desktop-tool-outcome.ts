/** Read the saved result before display truncation. Returned is not verified success. */
export function desktopToolOutcome(serialized: string): "returned" | "failed" {
  try {
    const value: unknown = JSON.parse(serialized);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const result = value as Record<string, unknown>;
      if (result.error != null || result.isError === true || result.status === "failed") return "failed";
    }
  } catch { return "failed"; }
  return "returned";
}
