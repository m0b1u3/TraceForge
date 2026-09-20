import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserViewport } from "../../apps/web/renderer/browser-viewport";
import "../../apps/web/renderer/browser-session-control.css";
const fixture = (window as any).embeddedReview;
void fixture.initialize().then(({ sessionId, takeoverId }: {sessionId: string; takeoverId: string}) => {
  const root = createRoot(document.getElementById("root")!);
  root.render(<BrowserViewport bridge={{ protocolVersion: 1, request: async () => ({status: 200, body: {}}),
    presentBrowser: fixture.present }} path="/fixture" sessionId={sessionId} takeoverId={takeoverId}
    send={fixture.command} onHide={() => { root.unmount(); document.getElementById("result")!.textContent = "页面已收起；可关闭验收窗口。"; }} />);
});
