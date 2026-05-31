import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import { LivequeryClientProvider } from "@livequery/react";
import { livequeryClient } from "@helpers/livequery-client";
import "@/styles.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Codex Proxy</title>
        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('codex-theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`,
          }}
        />
      </head>
      <body suppressHydrationWarning>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <LivequeryClientProvider core={livequeryClient}>
      <Outlet />
    </LivequeryClientProvider>
  );
}
