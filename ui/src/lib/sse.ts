import type { QueryClient } from "@tanstack/react-query";
import type { FactoryEvent } from "./events";
import { fetchState } from "./api";
import { isMockMode, replayFixtures } from "./fixtures";
import { getState, ingest, resetMission, setConnection } from "./store";

// ---------------------------------------------------------------------------
// startStream — single EventSource for the whole app (or the fixture replay in
// ?mock=1 mode; both feed the identical ingest() path). Boot order per §5.3:
// fetchState() seeds the mirror, then /events?since=<seq> streams the delta.
// EventSource auto-reconnects with Last-Event-ID; EVERY onopen (first connect
// included — the boot fetch may have failed) resyncs against /state, which is
// a superset of anything ring replay can deliver:
//   fresh.seq > ours → forward gap (ring evicted events while we were away, or
//                      the boot fetch failed) — reset to the snapshot, keep feeds.
//   fresh.seq < ours → daemon restarted (seq reset) — hard reset, drop feeds.
// Events arriving while the resync fetch is in flight are buffered and folded
// after the snapshot lands, so nothing emitted between the snapshot and the
// reset is lost.
// ---------------------------------------------------------------------------

let started = false;

export function startStream(queryClient: QueryClient): void {
  if (started) return;
  started = true;

  if (isMockMode()) {
    replayFixtures(
      (e) => {
        ingest(e);
        if (e.type === "run_finished") {
          void queryClient.invalidateQueries({ queryKey: ["runs"] });
        }
      },
      () => setConnection("live"),
    );
    return;
  }

  void boot(queryClient);
}

async function boot(queryClient: QueryClient): Promise<void> {
  try {
    const mission = await fetchState();
    resetMission(mission, { keepFeeds: true });
  } catch {
    // Daemon not up yet — the first onopen below resyncs.
  }

  const source = new EventSource(`/events?since=${getState().mission.seq}`);
  let resyncBuffer: FactoryEvent[] | null = null;

  const fold = (event: FactoryEvent): void => {
    if (event.seq <= getState().mission.seq) return; // replay overlap after resume
    ingest(event);
    if (event.type === "run_finished") {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    }
  };

  source.onopen = () => {
    setConnection("live");
    resyncBuffer = [];
    void fetchState()
      .then((fresh) => {
        const ours = getState().mission.seq;
        if (fresh.seq > ours) {
          resetMission(fresh, { keepFeeds: true }); // forward gap / failed boot
        } else if (fresh.seq < ours) {
          resetMission(fresh); // daemon restarted — stale feeds dropped
        }
        void queryClient.invalidateQueries({ queryKey: ["runs"] });
      })
      .catch(() => {
        // /state unreachable — fall through and fold live events best-effort;
        // the next reconnect retries the resync.
      })
      .finally(() => {
        const buffered = resyncBuffer ?? [];
        resyncBuffer = null;
        for (const event of buffered) fold(event);
      });
  };

  source.onerror = () => {
    setConnection("reconnecting");
  };

  source.onmessage = (msg: MessageEvent<string>) => {
    let event: FactoryEvent;
    try {
      event = JSON.parse(msg.data) as FactoryEvent;
    } catch {
      return;
    }
    if (typeof event.seq !== "number") return;
    if (resyncBuffer !== null) {
      resyncBuffer.push(event); // resync in flight — fold after the snapshot
      return;
    }
    fold(event);
  };
}
