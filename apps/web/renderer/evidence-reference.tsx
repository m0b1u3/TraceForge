import React, { useEffect, useMemo, useRef, useState } from "react";
import { useArtifactPreview } from "./artifact-preview";
import { CaretRight } from "@phosphor-icons/react";
import type { DesktopConversations } from "./desktop-conversation-transport";
import { evidencePng, evidenceText, readEvidencePage, type EvidenceContent } from "./evidence-client";

/** Inert local evidence viewer; no HTML, external image URL or file opener. */
export function EvidenceReference({ bridge, conversationId, runId, reference, embedded = false }: {
  bridge: DesktopConversations; conversationId: string; runId: string; reference: string; embedded?: boolean;
}) {
  const [opened, setOpened] = useState(embedded), [value, setValue] = useState<EvidenceContent>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const preview = useArtifactPreview();
  useEffect(() => { if (embedded) void read(); }, [bridge, conversationId, runId, reference, embedded]);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, [bridge, conversationId, runId, reference]);
  async function read(previous?: EvidenceContent) {
    active.current?.abort(); const abort = new AbortController(); active.current = abort;
    setBusy(true); setError("");
    try {
      let next = await readEvidencePage(bridge, conversationId, runId, reference, previous, abort.signal);
      // Raster preview needs complete digest verification; bounded by 4 MiB / 64 pages.
      while (next.page.format === "png" && !next.verified) next = await readEvidencePage(bridge, conversationId, runId, reference, next, abort.signal);
      if (!abort.signal.aborted) setValue(next);
    } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "正文读取失败。"); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  const png = useMemo(() => value ? evidencePng(value) : undefined, [value]);
  return <div className="evidence-reference">
    {!embedded && <button type="button" className="evidence-reference-toggle" aria-expanded={opened} onClick={() => {
      if (preview) { preview.open({kind:"evidence",conversationId,runId,reference,title:reference}); return; }
      if (opened) { active.current?.abort(); setValue(undefined); setError(""); setBusy(false); setOpened(false); }
      else { setOpened(true); void read(); }
    }}><CaretRight aria-hidden="true" /><span>{reference}</span><span className="evidence-reference-action">{opened ? "收起正文" : "查看正文"}</span></button>}
    {opened && <section className="evidence-reader" aria-label="证据正文">
      <p className="local-receipt">本地审计原文 · 不可信观察，内容不会作为指令执行，也不代表发现已验证。</p>
      {busy && <p role="status">正在读取并核对正文…</p>}
      {value && <>
        <p>{value.page.summary}</p>
        <p className="local-receipt">已读取 {value.bytes.length.toLocaleString()} / {value.page.byteSize.toLocaleString()} 字节 · {value.verified ? "完整内容摘要已核对" : "部分内容，尚未完成全文核对"}</p>
        {png ? <img className="evidence-image" src={png} alt="本地证据截图" onError={() => setError("图片解码失败，不能预览此正文。")} />
          : <pre className="evidence-raw" tabIndex={0} aria-label={value.page.format === "binary" ? "二进制前 256 字节" : "原始文本"}>{evidenceText(value)}</pre>}
        {value.page.format === "binary" && <p>此文件不作为文档或程序打开，仅显示前 256 字节的十六进制内容。</p>}
        <small className="evidence-digest">{value.page.digest}</small>
        {!value.verified && value.page.format === "text" && <button disabled={busy} onClick={() => void read(value)}>继续读取正文</button>}
      </>}
      {error && <p role="alert" className="inline-warning">{error}</p>}
      {error && <button disabled={busy} onClick={() => void read(value)}>重新读取正文</button>}
    </section>}
  </div>;
}
