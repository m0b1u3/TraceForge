import { lazy, Suspense, useEffect } from "react";
import { CheckCircle, CircleNotch, Info, Warning } from "@phosphor-icons/react";
import { AnimatePresence, MotionConfig, m } from "motion/react";
import { useStore } from "./store.js";
import { Launchpad } from "./components/Launchpad.js";

const Workbench = lazy(() => import("./components/Workbench.js"));
const SettingsModal = lazy(async () => ({ default: (await import("./components/SettingsModal.js")).SettingsModal }));

function Toast() {
  const toast = useStore((state) => state.toast);
  const Icon = toast?.tone === "error" ? Warning : toast?.tone === "success" ? CheckCircle : Info;
  return (
    <AnimatePresence>
      {toast && (
        <m.div
          className="tf-toast"
          data-tone={toast.tone}
          role={toast.tone === "error" ? "alert" : "status"}
          aria-live={toast.tone === "error" ? "assertive" : "polite"}
          initial={{ opacity: 0, y: 10, scale: .985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: .99 }}
          transition={{ duration: .18 }}
        >
          <Icon size={16} weight={toast.tone === "info" ? "regular" : "fill"} aria-hidden="true" />
          <span>{toast.message}</span>
        </m.div>
      )}
    </AnimatePresence>
  );
}

export function App() {
  const caseId = useStore((state) => state.caseId);
  const settingsModalOpen = useStore((state) => state.settingsModalOpen);
  const connectWs = useStore((state) => state.connectWs);
  useEffect(() => connectWs(), [connectWs]);

  if (!caseId) {
    return (
      <MotionConfig reducedMotion="user" transition={{ duration: .18, ease: [.2, .8, .2, 1] }}>
      <div className="app-shell">
        <Launchpad />
        {settingsModalOpen && <Suspense fallback={null}><SettingsModal /></Suspense>}
        <Toast />
      </div>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: .18, ease: [.2, .8, .2, 1] }}>
    <div className="app-shell">
      <Suspense fallback={<div className="workbench-loading" role="status"><CircleNotch className="tf-spin" size={18} /><span>Loading workbench…</span></div>}>
        <Workbench />
      </Suspense>
      <Toast />
    </div>
    </MotionConfig>
  );
}
