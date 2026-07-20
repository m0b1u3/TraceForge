import { useState } from "react";
import { CheckCircle, FileText, GitBranch, ShieldCheck } from "@phosphor-icons/react";
import { useStore } from "../../store.js";

export function ReportsTab() {
  const reports = useStore((state) => state.securityReports);
  const facts = useStore((state) => state.facts);
  const paths = useStore((state) => state.attackPaths);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = reports.find((report) => report.id === selectedId) ?? reports[0];

  if (!selected) {
    return (
      <div className="report-empty">
        <FileText size={18} weight="duotone" aria-hidden="true" />
        <h3>No evidence-backed report yet</h3>
        <p>A report appears only after at least one Finding is verified and its supporting evidence is persisted.</p>
        <div><span>Verified finding</span><span>Evidence</span><span>Review-ready report</span></div>
      </div>
    );
  }

  const reportFindings = selected.findingFactIds.flatMap((id) => {
    const fact = facts.find((item) => item.id === id);
    return fact ? [fact] : [];
  });
  const reportPaths = selected.attackPathIds.flatMap((id) => {
    const path = paths.find((item) => item.id === id);
    return path ? [path] : [];
  });

  return (
    <div className="report-workbench">
      <nav aria-label="Security reports">
        {reports.map((report) => (
          <button type="button" key={report.id} data-selected={report.id === selected.id} onClick={() => setSelectedId(report.id)}>
            <span>{report.status}</span>
            <strong>{report.title}</strong>
            <small>v{report.version} · {report.findingFactIds.length} findings</small>
          </button>
        ))}
      </nav>
      <article>
        <header>
          <div><span className="section-kicker">Security report</span><h3>{selected.title}</h3></div>
          <span className="report-status" data-status={selected.status}><ShieldCheck size={14} weight="fill" />{selected.status}</span>
        </header>
        <section>
          <h4>Executive summary</h4>
          <p>{selected.executiveSummary}</p>
        </section>
        {selected.scope && <section><h4>Scope</h4><p>{selected.scope}</p></section>}
        {selected.methodology && <section><h4>Methodology</h4><p>{selected.methodology}</p></section>}
        <section>
          <h4>Verified findings</h4>
          <div className="report-reference-list">
            {reportFindings.map((finding) => <div key={finding.id}><CheckCircle size={14} weight="fill" /><span><strong>{finding.title}</strong><code>{finding.id}</code></span></div>)}
          </div>
        </section>
        {reportPaths.length > 0 && (
          <section>
            <h4>Validated attack paths</h4>
            <div className="report-reference-list">
              {reportPaths.map((path) => <div key={path.id}><GitBranch size={14} /><span><strong>{path.title}</strong><code>{path.steps.length} verified steps · {path.id}</code></span></div>)}
            </div>
          </section>
        )}
        <section>
          <h4>Limitations</h4>
          {selected.limitations.length ? <ul>{selected.limitations.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No additional limitations were recorded.</p>}
        </section>
        <footer><span>{selected.evidenceRefs.length} evidence refs</span><span>{selected.sourceRunIds.length} source runs</span><code>{selected.id}</code></footer>
      </article>
    </div>
  );
}
