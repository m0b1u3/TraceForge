export interface ReplayRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ReplayResponse {
  status: number;
  bodyLength: number;
  body: string;
  headers: Record<string, string>;
}

export type Fetcher = (req: ReplayRequest) => Promise<ReplayResponse>;

// 受限网络下，对目标发包需经 HTTP 代理。node 原生 fetch 不读 HTTPS_PROXY/HTTP_PROXY、也不可靠透传
// dispatcher，故用 undici fetch（原生支持 dispatcher）+ 共用的 proxyDispatcher（@traceforge/shared，
// 与 LLM 调用同一套代理检测逻辑，DRY）。无代理 env 时直连。
const defaultFetcher: Fetcher = async (req) => {
  const { fetch: undiciFetch } = await import("undici");
  const { proxyDispatcher } = await import("@traceforge/shared");
  const dispatcher = proxyDispatcher();
  const res = await undiciFetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    ...(dispatcher ? { dispatcher } : {}),
  });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, bodyLength: body.length, body, headers };
};

export async function replay(req: ReplayRequest, fetcher: Fetcher = defaultFetcher): Promise<ReplayResponse> {
  return fetcher(req);
}

// 通用参数改写：把 query 中 param 设为任意 value，保留其它参数。不附加任何 payload。
export function modifyParam(req: ReplayRequest, param: string, value: string): ReplayRequest {
  const u = new URL(req.url);
  if (!u.searchParams.has(param)) return req;
  u.searchParams.set(param, value);
  return { ...req, url: u.toString() };
}

export interface CompareResult {
  statusChanged: boolean;
  lengthDelta: number;
}

// 只返回原始信号。不内置任何漏洞视角的关键词库——"像报错/像注入/像越权"等判断
// 由上层 LLM 直接读 base/variant 的完整 body 自行得出，引擎保持漏洞无关。
export function compareResponses(base: ReplayResponse, variant: ReplayResponse): CompareResult {
  return {
    statusChanged: base.status !== variant.status,
    lengthDelta: variant.bodyLength - base.bodyLength,
  };
}
