option: A
what: Session resumption across daemon restart
why: Right now restarting the daemon = pi creates a fresh session, agent loses all prior conversation. Pi-acm
  operates within session, so this is the biggest functional gap left.
rough effort: ~1h
────────────────────────────────────────
option: B
what: Activity digest
why: Completes the routing matrix story (sidebar-like indicator for unsubscribed channels). Modeled but not built.
rough effort: ~2h
────────────────────────────────────────
option: C
what: Buffering + flush-time formatting
why: Multi-message bursts currently deliver one user-turn each instead of one batched user-turn with relative
  timestamps. Real-server deploys will want this.
rough effort: ~2-3h
────────────────────────────────────────
option: D
what: Polish bundle
why: Missed-pings log; role-ping detection; native AgentTool registrations alongside bash
rough effort: ~1-2h together
