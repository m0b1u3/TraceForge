import React, { useEffect, useRef, useState } from "react";
import type { ModelAccountView, ModelLoginView, ModelSettingsClient } from "./model-settings-client";

const statusText = { signed_out: "未登录", connected: "已登录 · 调用权限仍需测试", refresh_required: "需要续期 · 下次调用自动尝试" };
export function ModelAccountPanel({ client, accounts, disabled, onBusy, onAccounts }: {
  client: ModelSettingsClient | null; accounts: ModelAccountView[]; disabled: boolean;
  onBusy(value: boolean): void; onAccounts(accounts: ModelAccountView[]): void;
}) {
  const [selected, setSelected] = useState(""); const id = selected || accounts[0]?.id || "";
  const account = accounts.find(item => item.id === id);
  const [login, setLogin] = useState<ModelLoginView | null>(null);
  const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false); const lock = useRef(false);
  const [automatic, setAutomatic] = useState(true);
  useEffect(() => {
    if (!login || !automatic || busy || disabled) return;
    const timer = setTimeout(() => {
      if (Date.now() >= login.expiresAt) { setAutomatic(false); setError("授权已过期，请取消本次登录后重新开始。"); return; }
      void run("poll");
    }, login.intervalMs);
    return () => clearTimeout(timer);
  }, [login, automatic, busy, disabled]);
  async function openBrowser() {
    if (!client || lock.current || disabled) return;
    lock.current = true; setBusy(true); onBusy(true);
    try { await client.openLogin(id); }
    catch { setError("无法确认浏览器已打开。请手动打开下方授权地址。"); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  }
  async function run(operation: "begin" | "poll" | "cancel" | "disconnect" | "refresh") {
    if (!client || !id || disabled || lock.current) return;
    lock.current = true; setBusy(true); onBusy(true); setError(""); setNotice("");
    try {
      if (operation !== "refresh") {
        const result = await client.account(operation, id);
        if (operation === "begin") { setLogin(result.login!); setAutomatic(true); }
        else if (result.state !== "pending") setLogin(null);
        setNotice(result.state === "pending" ? "等待你在供应商网页授权，页面会自动检查结果。" : result.state === "connected"
          ? "账号已登录。请在下方选择该连接并保存模型配置；登录不代表模型调用已通过。"
          : result.state === "signed_out" ? "本产品已移除该账号凭据。现有配置仍保留，但不能继续用它调用。" : "已取消本次登录。");
      }
      const snapshot = await client.load(); onAccounts(snapshot.accounts ?? []);
    } catch (cause) { setLogin(null); setError((cause as Error).message); }
    finally { lock.current = false; setBusy(false); onBusy(false); setConfirm(false); }
  }
  return <section className="model-account-panel" aria-label="账号授权连接">
    <h3>账号授权连接</h3>
    {!accounts.length ? <p className="field-help">尚未安装可用的账号授权注册。Grok 登录不会默认借用其他工具身份；API Key 配置仍可使用。</p> : <>
      <label>账号连接<select aria-label="账号连接" value={id} disabled={disabled || busy || !!login} onChange={event => { setSelected(event.target.value); setError(""); setNotice(""); setConfirm(false); }}>
        {accounts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      {account && <><p className="field-help">{statusText[account.status]}</p><p className="field-help">授权方：{account.issuer}<br />申请权限：{account.scopes.join("、")}<br />模型端点：{account.baseUrl}</p></>}
      {login && <div className="model-login-instructions"><p>在浏览器打开以下地址并输入验证码。不要把密码或验证码发送到对话中。</p>
        <button type="button" disabled={disabled || busy} onClick={() => void openBrowser()}>打开授权网页</button>
        <label><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)} />自动检查授权结果</label>
        <p><code>{login.verificationUrl}</code></p><p>验证码：<code>{login.userCode}</code></p>
        <p className="field-help">有效期至 {new Date(login.expiresAt).toLocaleTimeString()}。此页面不接收你的供应商密码。</p></div>}
      <div className="model-account-actions">
        {login ? <><button type="button" disabled={disabled || busy} onClick={() => void run("poll")}>检查登录</button><button type="button" disabled={disabled || busy} onClick={() => void run("cancel")}>取消登录</button></>
          : <button type="button" disabled={disabled || busy} onClick={() => void run("begin")}>登录账号</button>}
        <button type="button" disabled={disabled || busy} onClick={() => void run("refresh")}>刷新账号状态</button>
        <button type="button" disabled={disabled || busy || account?.status === "signed_out"} onClick={() => setConfirm(true)}>退出账号</button>
      </div>
      {confirm && <div className="model-reload-confirm"><p>退出将移除本产品的账号凭据，使用它的模型连接将不能继续调用。不会代替供应商网页撤销授权。</p><button type="button" disabled={busy} onClick={() => setConfirm(false)}>保留登录</button><button type="button" disabled={busy} onClick={() => void run("disconnect")}>确认退出</button></div>}
      {error && <p className="model-error" role="alert">{error}</p>}<p role="status" className="model-result">{busy ? "正在处理账号操作…" : notice}</p>
    </>}
  </section>;
}
