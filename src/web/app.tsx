import { createRoot } from "react-dom/client";
import { LivequeryClientProvider } from "@livequery/react";
import { Dashboard } from "./Dashboard";
import { livequeryClient } from "./livequery-client";
import "./styles.css";

function App() {
  return (
    <LivequeryClientProvider core={livequeryClient}>
      <Dashboard />
    </LivequeryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
