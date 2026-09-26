import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserViewport } from "../../apps/web/renderer/browser-viewport";
import "../../apps/web/renderer/browser-session-control.css";
const fixture = (window as any).embeddedReview;
void fixture.initialize().then(({ sessionId, takeoverId }: {sessionId: string; takeoverId: string}) => {
  const root = createRoot(document.getElementById("root")!);
  function ReviewApp() {
    const [visible, setVisible] = useState(true);
    const finish = (message: string) => { setVisible(false); document.getElementById("result")!.textContent = message; };
    return visible ? <BrowserViewport bridge={{ protocolVersion: 1, request: async () => ({ status: 200, body: {} }),
      presentBrowser: fixture.present }} path="/fixture" sessionId={sessionId} takeoverId={takeoverId}
      send={async command => { const ok = await fixture.command(command); if (ok) finish("已交回；宿主已回读同一页面状态。"); return ok; }}
      onHide={() => finish("页面已收起；可关闭验收窗口。")}/>: null;
  }
  root.render(<ReviewApp />);
});
