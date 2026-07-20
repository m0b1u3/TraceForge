import { useEffect, useState } from "react";
import { Check, CheckCircle, ClockCounterClockwise, DownloadSimple, FileText, GitBranch, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { useStore } from "../../store.js";
import { acceptSecurityReportRevision, downloadSecurityReport, listSecurityReportRevisions } from "../../api.js";
import { Button } from "../ui/button.js";
import type { SecurityReportRevision } from "@traceforge/shared";

export function ReportsTab() {
  const reports = useStore((state) => state.securityReports);
  const facts = useStore((state) => state.facts);
  const paths = useStore((state) => state.attackPaths);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"markdown" | "json" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<SecurityReportRevision[]>([]);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const selected = reports.find((report) => report.id === selectedId) ?? reports[0];
  useEffect(() => {
    if (!selected) return;
    let active = true;
    void listSecurityReportRevisions(selected.caseId, selected.id).then((items) => {
      if (!active) return;
      setRevisions(items);
      setSelectedRevisionId(items.at(-1)?.id ?? null);
    }).catch(() => {
      if (!active) return;
      setRevisions([]);
      setSelectedRevisionId(null);
    });
    return () => { active = false; };
  }, [selected?.caseId, selected?.id, selected?.version]);

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
  const selectedRevision = revisions.find((revision) => revision.id === selectedRevisionId) ?? revisions.at(-1);
  const acceptRevision = async () => {
    if (!selectedRevision) return;
    const accepted = await acceptSecurityReportRevision(selected.caseId, selected.id, selectedRevision.id);
    setRevisions((items) => items.map((item) => item.id === accepted.id ? accepted : item));
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
            <Button type="button" variant="ghost" size="sm" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
              <ClockCounterClockwise size={13} />History
            </Button>
          </div>
        </header>
        {historyOpen && selectedRevision && (
          <section className="report-history" aria-label="Report version history">
            <div className="report-history-versions">
              {revisions.map((revision) => (
                <button type="button" key={revision.id} data-selected={revision.id === selectedRevision.id} onClick={() => setSelectedRevisionId(revision.id)}>
                  <span>v{revision.version}</span>
                  <strong>{revision.changeType.replaceAll("_", " ")}</strong>
                  <small>{revision.reviewDecision}</small>
                </button>
              ))}
            </div>
            <div className="report-diff">
              <header><div><span className="section-kicker">Revision diff</span><strong>Version {selectedRevision.version}</strong></div>
                <Button type="button" size="sm" variant="outline" disabled={selectedRevision.reviewDecision === "accepted"} onClick={() => void acceptRevision()}>
                  <Check size={13} />{selectedRevision.reviewDecision === "accepted" ? "Accepted" : "Accept revision"}
                </Button>
              </header>
              <dl>
                <div><dt>Changed</dt><dd>{selectedRevision.diff.changedFields.join(", ") || "No content fields"}</dd></div>
                <div><dt>Findings</dt><dd><ins>+{selectedRevision.diff.addedFindingFactIds.length}</ins><del>−{selectedRevision.diff.removedFindingFactIds.length}</del></dd></div>
                <div><dt>Paths</dt><dd><ins>+{selectedRevision.diff.addedAttackPathIds.length}</ins><del>−{selectedRevision.diff.removedAttackPathIds.length}</del></dd></div>
                <div><dt>Evidence</dt><dd><ins>+{selectedRevision.diff.addedEvidenceRefs.length}</ins><del>−{selectedRevision.diff.removedEvidenceRefs.length}</del></dd></div>
              </dl>
              <p>{new Date(selectedRevision.createdAt).toLocaleString()} · immutable snapshot</p>
            </div>
          </section>
        )}
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
