import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import { LivequeryClientProvider } from "@livequery/react";
import { Provider as ChakraProvider } from "@components/ui/provider";
import { ColorModeSync } from "@components/ui/color-mode-sync";
import { AccountsProvider } from "@context/accounts-context";
import { AuthProvider, useAuth } from "@context/auth-context";
import { useLivequeryClient } from "@/hooks/useWorkerService";
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
            __html: `(function(){try{var t=localStorage.getItem('codex-theme')||'dark';var e=document.documentElement;e.setAttribute('data-theme',t);e.classList.remove(t==='dark'?'light':'dark');e.classList.add(t);}catch(e){document.documentElement.setAttribute('data-theme','dark');document.documentElement.classList.add('dark');}})();`,
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
  const livequeryClient = useLivequeryClient();

  return (
    <ChakraProvider defaultTheme="dark" storageKey="codex-theme">
      <ColorModeSync />
      <LivequeryClientProvider core={livequeryClient}>
        <AuthProvider>
          <AuthReadyGate>
            <AccountsProvider>
              <Outlet />
            </AccountsProvider>
          </AuthReadyGate>
        </AuthProvider>
      </LivequeryClientProvider>
    </ChakraProvider>
  );
}

function AuthReadyGate({ children }: { children: React.ReactNode }) {
  const { ready } = useAuth();
  if (!ready) return <div className="app-boot"><span className="inline-spinner" /></div>;
  return <>{children}</>;
}
