import { useEffect, useState } from "react";
import { useStore } from "./store.js";
import { createCase, openUrl } from "./api.js";

export function App() {
  const { caseId, traffic, setCase, connectWs } = useStore();
  const [name, setName] = useState("demo");
  const [hosts, setHosts] = useState("example.com");
  const [url, setUrl] = useState("https://example.com/");

  useEffect(() => {
    connectWs();
  }, [connectWs]);

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>TraceForge</h1>
      {!caseId ? (
        <div>
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
      ) : (
        <div>
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
              </tr>
            </thead>
            <tbody>
              {traffic.map((t) => (
                <tr key={t.id}>
                  <td>{t.method}</td>
                  <td>{t.responseStatus}</td>
                  <td>{t.url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
