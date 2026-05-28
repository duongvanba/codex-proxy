import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LivequeryClientProvider } from "@livequery/react";
import { Dashboard } from "./Dashboard";
import { WorkspacePage } from "./WorkspacePage";
import { livequeryClient } from "./livequery-client";
import "./styles.css";

type Page =
  | { type: "dashboard" }
  | { type: "workspace"; accountId: string };

function App() {
  const [page, setPage] = useState<Page>({ type: "dashboard" });

  return (
    <LivequeryClientProvider core={livequeryClient}>
      {page.type === "dashboard" ? (
        <Dashboard onAccountClick={(id) => setPage({ type: "workspace", accountId: id })} />
      ) : (
        <WorkspacePage
          accountId={page.accountId}
          onBack={() => setPage({ type: "dashboard" })}
        />
      )}
    </LivequeryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
