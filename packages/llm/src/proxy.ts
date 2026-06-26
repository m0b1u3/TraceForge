import { ProxyAgent, fetch as undiciFetch } from "undici";

// 受限网络下，LLM API 需经 HTTP 代理访问。Anthropic / OpenAI SDK 的底层 fetch（undici）默认不读
// HTTPS_PROXY/HTTP_PROXY 环境变量，这里显式构造走 ProxyAgent 的 fetch。
// 无代理 env 时返回 undefined（直连不受影响），由 provider 决定是否传给 SDK。
export function proxyFetch(): typeof fetch | undefined {
  const proxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy) return undefined;
  const agent = new ProxyAgent(proxy);
  const f = (input: unknown, init: Record<string, unknown> = {}) =>
    undiciFetch(input as never, { ...init, dispatcher: agent } as never);
  return f as unknown as typeof fetch;
}
