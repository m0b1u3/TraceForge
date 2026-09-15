import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Model text is untrusted content: no HTML execution or automatic remote image fetches. */
export function MessageMarkdown({ text }: { text: string }) {
  return <div className="message-markdown" dir="auto"><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => href && /^https?:\/\//i.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>,
    img: ({ src, alt }) => src && /^https?:\/\//i.test(src)
      ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || "查看图片"}（外部图片）</a>
      : <span>{alt || "图片地址不可用"}</span>,
    pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
    table: ({ children }) => <div className="message-table" tabIndex={0} role="region" aria-label="回复表格"><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
