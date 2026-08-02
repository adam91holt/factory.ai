import { useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/** Desktop: fixed sidebar + content. Mobile (<md): sidebar becomes a slide-over
 *  drawer opened from the Topbar hamburger — same Sidebar component in both,
 *  so nav/badges/active-runs can never drift between form factors. The drawer
 *  closes on navigation and on backdrop tap. */
export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Belt-and-braces close: any route change dismisses the drawer even if a
  // navigation happens by means other than tapping a sidebar link.
  useRouterState({ select: (s) => s.location.pathname, structuralSharing: true });

  return (
    <div className="flex h-full bg-bg0 text-fg">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-bg0/70 backdrop-blur-[2px]"
          />
          <div className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] shadow-2xl shadow-black/50 feed-in">
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setDrawerOpen(true)} />
        <main className="min-h-0 flex-1 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
