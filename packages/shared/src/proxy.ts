import { ProxyAgent, fetch as undiciFetch } from "undici";

// 受限网络下，对外请求（LLM API、对目标发包等）需经 HTTP 代理。node 的 fetch（undici）默认不读
// HTTPS_PROXY/HTTP_PROXY 环境变量，这里统一检测并显式构造走 ProxyAgent 的 dispatcher。
// 无代理 env 时返回 undefined（直连不受影响），由调用方决定是否使用。
// 跨包共用：llm provider、tools http_replay 等所有对外请求都走这里，避免重复实现。
export function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  );
}

/** 有代理 env 时返回走代理的 ProxyAgent dispatcher，否则 undefined。供 undici fetch 的 dispatcher 选项用。 */
export function proxyDispatcher(): ProxyAgent | undefined {
  const proxy = getProxyUrl();
  return proxy ? new ProxyAgent(proxy) : undefined;
}

/**
 * 返回一个走代理的 fetch（兼容 SDK 的自定义 fetch 选项）；无代理 env 时返回 undefined。
 * 用于 Anthropic / OpenAI SDK 的 fetch 注入。
 */
export function proxyFetch(): typeof fetch | undefined {
  const agent = proxyDispatcher();
  if (!agent) return undefined;
  const f = (input: unknown, init: Record<string, unknown> = {}) =>
    undiciFetch(input as never, { ...init, dispatcher: agent } as never);
  return f as unknown as typeof fetch;
}
