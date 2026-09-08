import { DesktopEvidencePageSchema, EVIDENCE_MAX_BYTES, EVIDENCE_PAGE_BYTES, type DesktopEvidencePage } from "@traceforge/shared/desktop-evidence";
import type { DesktopConversations } from "./desktop-conversation-transport";

export interface EvidenceContent { page: DesktopEvidencePage; bytes: Uint8Array; verified: boolean }
export async function readEvidencePage(bridge: DesktopConversations, conversationId: string, runId: string, ref: string,
  previous?: EvidenceContent, signal?: AbortSignal): Promise<EvidenceContent> {
  signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId)) throw new Error("会话标识无效。");
  if (previous?.page.nextOffset === null) return previous;
  const offset = previous?.page.nextOffset ?? 0;
  const response = await bridge.request({ path: `/api/desktop/conversations/${conversationId}/evidence/read`, method: "POST",
    body: JSON.stringify({ runId, ref, offset, ...(previous ? { expectedDigest: previous.page.digest } : {}) }) });
  signal?.throwIfAborted();
  if (response.status === 404) throw new Error("此引用没有可读取的本地正文，或不属于当前会话与运行。不访问外部网址或猜测文件路径。");
  if (response.status !== 200) throw new Error("正文读取失败或完整性检查未通过，请重试。未重新执行原操作。");
  const parsed = DesktopEvidencePageSchema.safeParse(response.body);
  if (!parsed.success) throw new Error("正文回执格式无效。");
  const page = parsed.data;
  if (page.ref !== ref || page.runId !== runId || page.offset !== offset || (previous &&
    (previous.page.digest !== page.digest || previous.page.artifactId !== page.artifactId || previous.page.byteSize !== page.byteSize
      || previous.page.format !== page.format || previous.bytes.length !== offset))) throw new Error("正文来源或分页身份改变。");
  let binary: string;
  try { binary = atob(page.bodyBase64); } catch { throw new Error("正文编码无效。"); }
  const end = offset + binary.length;
  if (btoa(binary) !== page.bodyBase64 || binary.length !== Math.min(EVIDENCE_PAGE_BYTES, page.byteSize - offset) || end > page.byteSize || end > EVIDENCE_MAX_BYTES
    || (page.nextOffset === null ? end !== page.byteSize : page.nextOffset !== end || end >= page.byteSize || !binary.length))
    throw new Error("正文分页不完整。");
  const bytes = new Uint8Array(end); if (previous) bytes.set(previous.bytes);
  for (let index = 0; index < binary.length; index++) bytes[offset + index] = binary.charCodeAt(index);
  const verified = page.nextOffset === null;
  if (verified) {
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    signal?.throwIfAborted();
    if (`sha256:${actual}` !== page.digest) throw new Error("正文摘要不匹配，未显示为完整证据。");
  }
  return { page, bytes, verified };
}

export function evidenceText(value: EvidenceContent): string {
  if (value.page.format === "binary") return Array.from(value.bytes.subarray(0, 256), byte => byte.toString(16).padStart(2, "0")).join(" ");
  // Streaming mode leaves a trailing partial UTF-8 character out of the preview.
  return new TextDecoder("utf-8").decode(value.bytes, { stream: !value.verified });
}
export function evidencePng(value: EvidenceContent): string | undefined {
  if (!value.verified || value.page.format !== "png") return undefined;
  let binary = ""; for (const byte of value.bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}
