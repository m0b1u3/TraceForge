import { useEffect, useState } from "react";
import { useStore } from "./store.js";
import { createCase, openUrl, runAgent, resolveApproval } from "./api.js";

export function App() {
  const {
    caseId, traffic, facts, tasks, timeline, actions, decisions,
    agentEvents, pendingApproval, setCase, connectWs, resetAgent,
  } = useStore();
  const [name, setName] = useState("demo");
  const [hosts, setHosts] = useState("example.com");
  const [url, setUrl] = useState("https://example.com/");
  const [goal, setGoal] = useState("看一下已抓的流量，把发现的接口记录为 Fact。");

  useEffect(() => { connectWs(); }, [connectWs]);

  if (!caseId) {
    return (
      <div style={{ fontFamily: "sans-serif", padding: 16 }}>
        <h1>TraceForge</h1>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="case name" />
        <input value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="allow hosts (comma)" />
        <button onClick={async () => {
          const c = await createCase(name, hosts.split(",").map((h) => h.trim()));
          setCase(c.id);
        }}>Create Case</button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>TraceForge</h1>
      <p>Case: {caseId}</p>

      <h2>抓流量</h2>
      <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 360 }} />
      <button onClick={() => openUrl(caseId, url)}>Open</button>
      <table border={1} cellPadding={4}>
        <thead><tr><th>Method</th><th>Status</th><th>URL</th></tr></thead>
        <tbody>
          {traffic.map((t) => (
            <tr key={t.id}><td>{t.method}</td><td>{t.responseStatus}</td><td>{t.url}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>Agent</h2>
      <textarea value={goal} onChange={(e) => setGoal(e.target.value)} style={{ width: 480, height: 50 }} />
      <div>
        <button onClick={() => { resetAgent(); runAgent(caseId, goal); }}>启动 Agent</button>
      </div>
      {pendingApproval && (
        <div style={{ border: "2px solid orange", padding: 8, margin: "8px 0" }}>
          <b>需要确认：</b>{pendingApproval.tool}({pendingApproval.input}){" "}
          <button onClick={() => resolveApproval(pendingApproval.approvalId, "approved")}>批准</button>{" "}
          <button onClick={() => resolveApproval(pendingApproval.approvalId, "rejected")}>拒绝</button>
        </div>
      )}
      <h3>Agent 活动 ({agentEvents.length})</h3>
      <ul>
        {agentEvents.map((e, i) => (
          <li key={i}>
            <span style={{ color: e.kind === "error" ? "red" : e.kind === "tool_call" ? "blue" : "black" }}>
              [{e.kind}]
            </span>{" "}
            {e.text}
          </li>
        ))}
      </ul>

      <h2>Facts ({facts.length})</h2>
      <ul>{facts.map((f) => <li key={f.id}>[{f.type}] {f.title}</li>)}</ul>

      <h2>Tasks ({tasks.length})</h2>
      <ul>{tasks.map((t) => <li key={t.id}>[{t.status}] {t.title}</li>)}</ul>

      <h2>Actions ({actions.length})</h2>
      <ul>{actions.map((a) => <li key={a.id}>[{a.tool}/{a.priority}] {a.title}</li>)}</ul>

      <h2>Decisions ({decisions.length})</h2>
      <ul>{decisions.map((d) => <li key={d.id}>{d.decision} ← {d.basedOn.join(", ")}</li>)}</ul>

      <h2>Timeline ({timeline.length})</h2>
      <ol>{timeline.map((e) => <li key={e.id}>{e.eventType}: {e.detail}</li>)}</ol>
    </div>
  );
}
