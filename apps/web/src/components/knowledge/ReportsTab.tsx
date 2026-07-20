import { useState } from "react";
import { CheckCircle, DownloadSimple, FileText, GitBranch, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { useStore } from "../../store.js";
import { downloadSecurityReport } from "../../api.js";
import { Button } from "../ui/button.js";

export function ReportsTab() {
  const reports = useStore((state) => state.securityReports);
  const facts = useStore((state) => state.facts);
  const paths = useStore((state) => state.attackPaths);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"markdown" | "json" | null>(null);
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
  const exportReport = async (format: "markdown" | "json") => {
    setExporting(format);
    try {
      await downloadSecurityReport(selected.caseId, selected.id, format);
    } finally {
      setExporting(null);
    }
  };

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
          <div className="report-actions">
            <span className="report-status" data-status={selected.reviewStatus === "needs_review" ? "needs_review" : selected.status}>
              {selected.reviewStatus === "needs_review" ? <WarningCircle size={14} weight="fill" /> : <ShieldCheck size={14} weight="fill" />}
              {selected.reviewStatus === "needs_review" ? "review required" : selected.status}
            </span>
            <Button type="button" variant="ghost" size="sm" disabled={exporting !== null} onClick={() => void exportReport("markdown")} aria-label="Export report as Markdown">
              <DownloadSimple size={13} />{exporting === "markdown" ? "Exporting" : "MD"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={exporting !== null} onClick={() => void exportReport("json")} aria-label="Export report as JSON">
              <DownloadSimple size={13} />{exporting === "json" ? "Exporting" : "JSON"}
            </Button>
          </div>
        </header>
        {selected.reviewReasons.length > 0 && (
          <aside className="report-review-warning" aria-label="Report requires review">
            <WarningCircle size={16} weight="fill" />
            <div><strong>Dependencies changed after generation</strong>{selected.reviewReasons.map((reason) => <p key={reason}>{reason}</p>)}</div>
          </aside>
        )}
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
