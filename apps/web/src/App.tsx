import { useEffect, useState } from "react";
import { useStore } from "./store.js";
import { createCase, openUrl, createFact, createTask, patchTask } from "./api.js";

export function App() {
  const { caseId, traffic, facts, tasks, timeline, setCase, connectWs } = useStore();
  const [name, setName] = useState("demo");
  const [hosts, setHosts] = useState("example.com");
  const [url, setUrl] = useState("https://example.com/");

  useEffect(() => {
    connectWs();
  }, [connectWs]);

  if (!caseId) {
    return (
      <div style={{ fontFamily: "sans-serif", padding: 16 }}>
        <h1>TraceForge</h1>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="case name" />
        <input
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
          placeholder="allow hosts (comma)"
        />
        <button
          onClick={async () => {
            const c = await createCase(
              name,
              hosts.split(",").map((h) => h.trim()),
            );
            setCase(c.id);
          }}
        >
          Create Case
        </button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>TraceForge</h1>
      <p>Case: {caseId}</p>
      <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 360 }} />
      <button onClick={() => openUrl(caseId, url)}>Open</button>

      <h2>Traffic ({traffic.length})</h2>
      <table border={1} cellPadding={4}>
        <thead>
          <tr>
            <th>Method</th>
            <th>Status</th>
            <th>URL</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {traffic.map((t) => (
            <tr key={t.id}>
              <td>{t.method}</td>
              <td>{t.responseStatus}</td>
              <td>{t.url}</td>
              <td>
                <button
                  onClick={() => {
                    const title = window.prompt("Fact title", t.url) ?? t.url;
                    createFact(caseId, {
                      type: "api_endpoint",
                      title,
                      value: { url: t.url, method: t.method },
                      source: { type: "traffic", ref: t.id },
                    });
                  }}
                >
                  Mark as Fact
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Facts ({facts.length})</h2>
      <ul>
        {facts.map((f) => (
          <li key={f.id}>
            [{f.type}] {f.title}
          </li>
        ))}
      </ul>

      <h2>Tasks ({tasks.length})</h2>
      <button
        onClick={() => {
          const title = window.prompt("Blocked task title");
          if (title)
            createTask(caseId, {
              title,
              status: "blocked",
              reason: "manually created",
              blockedBy: ["credential"],
              triggerWhen: ["credential_found"],
              relatedFacts: [],
              priority: "medium",
            });
        }}
      >
        New blocked task
      </button>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            [{t.status}] {t.title} <button onClick={() => patchTask(t.id, "done")}>mark done</button>
          </li>
        ))}
      </ul>

      <h2>Timeline ({timeline.length})</h2>
      <ol>
        {timeline.map((e) => (
          <li key={e.id}>
            {e.eventType}: {e.detail}
          </li>
        ))}
      </ol>
    </div>
  );
}
