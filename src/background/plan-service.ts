/**
 * Plan-approval service.
 *
 * Mirrors PermissionService: when the agent proposes a plan, `requestApproval`
 * parks on a Promise until the panel resolves it via `resolve()` (approve /
 * reject). On SW restart the parked Promise is lost; the loop's
 * resumeIfInterrupted re-emits the plan so the user can still approve.
 *
 * Unlike the permission service, there's no grant store -- plan approval is
 * scoped to a single run (matched by runId in the session), so each new user
 * message requires a fresh plan.
 */

export type PlanDecision = "approve" | "reject";

interface PendingPlan {
  sessionId: string;
  planId: string;
  resolve: (d: PlanDecision) => void;
}

class PlanService {
  private pending = new Map<string, PendingPlan>();

  /** Ask the user to approve a plan. Resolves when they answer. */
  requestApproval(sessionId: string, planId: string): Promise<PlanDecision> {
    return new Promise<PlanDecision>((resolve) => {
      this.pending.set(planId, { sessionId, planId, resolve });
    });
  }

  /** Resolve a pending plan from the UI. */
  resolve(planId: string, decision: PlanDecision): void {
    const req = this.pending.get(planId);
    if (!req) return;
    this.pending.delete(planId);
    req.resolve(decision);
  }

  /** Abort all pending plans for a session (e.g. user clicked Stop). */
  abortSession(sessionId: string): void {
    for (const [id, req] of this.pending) {
      if (req.sessionId === sessionId) {
        this.pending.delete(id);
        req.resolve("reject");
      }
    }
  }

  /** True if a plan approval is pending for this session. */
  hasPending(sessionId: string): boolean {
    for (const req of this.pending.values()) {
      if (req.sessionId === sessionId) return true;
    }
    return false;
  }
}

export const planService = new PlanService();
