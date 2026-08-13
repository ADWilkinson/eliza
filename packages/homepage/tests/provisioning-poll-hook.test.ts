/**
 * Hook-level test for the shared-onboarding provisioning poll.
 *
 * Mounts useElizaAppProvisioningChat with a shared onboarding session id,
 * controls elizacloudAuthFetch via mock.module, and proves:
 * - the immediate (mount) request carries statusOnly:true with no message
 * - the 5-second interval request carries statusOnly:true with no message
 * - the returned transcript has no poll-generated duplicate assistant replies
 * - cleanup (ready-state transition and unmount) stops further polling
 *
 * Uses jsdom (already a root devDependency) to provide the DOM React needs,
 * and a controllable timer shim so tests advance the 5 s poll deterministically
 * while React-settling waits stay on the captured host timer.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Capture every fetch invocation so tests can assert on the request body.
const fetchCalls: Array<{ url: string; body: unknown }> = [];

// The mock returns a provisioning-pending response so the poll loop keeps
// running until the test deliberately flips the status to "running".
let nextStatus = "pending";

// --- Controllable poll scheduler ---
// Production recursively schedules setTimeout(callback, 5000). We capture the
// callback so tests can fire it on demand, proving the scheduled retry (not
// just the immediate call) carries the correct body. We also track which
// timers were cleared.
interface CapturedTimer {
  callback: () => void;
  cleared: boolean;
  delay: number;
  repeats: boolean;
}
let capturedTimers: CapturedTimer[] = [];
let activeTimers: Set<CapturedTimer> = new Set();

// mock.module intercepts the import inside use-eliza-app-provisioning-chat.ts.
// The source file uses the @/ alias (resolved by Vite/tsconfig to src/), so we
// register the mock under both the alias path and the relative path.
const clientMock = {
  elizacloudAuthFetch: mock(async (url: string, init?: RequestInit) => {
    const bodyStr = init?.body as string | undefined;
    let parsedBody: unknown;
    if (bodyStr) {
      try {
        parsedBody = JSON.parse(bodyStr);
      } catch {
        parsedBody = bodyStr;
      }
    }
    fetchCalls.push({ url, body: parsedBody });

    if (url === "/api/eliza-app/onboarding/chat") {
      const isStatusOnly =
        typeof parsedBody === "object" &&
        parsedBody !== null &&
        (parsedBody as Record<string, unknown>).statusOnly === true;

      // When the test sets nextStatus to "running", include a bridgeUrl so
      // the hook transitions to isReady and stops the interval.
      const isRunning = nextStatus === "running";
      return {
        success: true,
        data: {
          reply: isStatusOnly
            ? "on it, your agent is spinning up now."
            : "Hi! I'm Eliza.",
          provisioning: {
            status: nextStatus,
            agentId: isRunning ? "agent-123" : null,
            bridgeUrl: isRunning ? "https://agent-123.example" : null,
          },
          messages: [
            {
              role: "assistant" as const,
              content: "Hi! I'm Eliza.",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
          handoffComplete: false,
        },
      };
    }

    return { success: true, data: {} };
  }),
};
// Register mocks for the @/-prefixed modules the hook imports.
// bun:test does not read tsconfig.app.json (where the Vite "@" alias lives),
// so we use mock.module to intercept both the alias form and the real path.
mock.module("@/lib/api/client", () => clientMock);
// provisioning-poll-body is a pure function — let the real module load but
// intercept the alias so it resolves.
mock.module("@/lib/provisioning-poll-body", () =>
  import("../src/lib/provisioning-poll-body").then((m) => m),
);

// Import after mocks are registered.
const { useElizaAppProvisioningChat } = await import(
  "../src/lib/hooks/use-eliza-app-provisioning-chat"
);
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { JSDOM } = await import("jsdom");

const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;
const hostSetInterval = globalThis.setInterval;
const hostClearInterval = globalThis.clearInterval;
const POLL_DELAY_MS = 5_000;
const overriddenGlobalKeys = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "localStorage",
] as const;
const originalGlobalDescriptors = new Map(
  overriddenGlobalKeys.map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
let currentDom: InstanceType<typeof JSDOM> | null = null;
const mountedRoots = new Set<ReturnType<typeof createRoot>>();

function waitForHostTimer(delay = 0): Promise<void> {
  return new Promise((resolve) => hostSetTimeout(resolve, delay));
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await waitForHostTimer(5);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function captureTimer(
  callback: () => void,
  delay: number,
  repeats: boolean,
): CapturedTimer {
  const timer: CapturedTimer = {
    callback,
    cleared: false,
    delay,
    repeats,
  };
  capturedTimers.push(timer);
  activeTimers.add(timer);
  return timer;
}

function clearCapturedTimer(id: unknown): boolean {
  if (typeof id !== "object" || id === null) return false;
  const timer = id as CapturedTimer;
  if (!capturedTimers.includes(timer)) return false;
  timer.cleared = true;
  activeTimers.delete(timer);
  return true;
}

function setupDom() {
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  currentDom = dom;
  const { window } = dom;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.navigator = window.navigator;
  g.HTMLElement = window.HTMLElement;
  g.localStorage = window.localStorage;

  // Override setInterval/setTimeout with controllable shims. Production
  // now schedules the 5-second poll via recursive setTimeout (single-flight
  // + generation token); legacy setInterval is kept for backwards compat.
  g.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const [callback, delay, ...callbackArgs] = args;
    if (delay === POLL_DELAY_MS && typeof callback === "function") {
      return captureTimer(
        () => callback(...callbackArgs),
        delay,
        true,
      ) as unknown as ReturnType<typeof setInterval>;
    }
    return hostSetInterval(...args);
  }) as typeof setInterval;
  g.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
    if (!clearCapturedTimer(id)) hostClearInterval(id);
  }) as typeof clearInterval;
  g.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const [callback, delay, ...callbackArgs] = args;
    if (delay === POLL_DELAY_MS && typeof callback === "function") {
      return captureTimer(
        () => callback(...callbackArgs),
        delay,
        false,
      ) as unknown as ReturnType<typeof setTimeout>;
    }
    return hostSetTimeout(...args);
  }) as typeof setTimeout;
  g.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    if (!clearCapturedTimer(id)) hostClearTimeout(id);
  }) as typeof clearTimeout;

  return window as unknown as Window & typeof globalThis;
}

/** Fire each active timer once, preserving interval vs one-shot semantics. */
async function tickPollTimers() {
  const timers = [...activeTimers];
  for (const timer of timers) {
    if (!timer.cleared) {
      if (!timer.repeats) {
        timer.cleared = true;
        activeTimers.delete(timer);
      }
      await timer.callback();
    }
  }
}

function pollCallCount(): number {
  return fetchCalls.filter(
    (call) => call.url === "/api/eliza-app/onboarding/chat",
  ).length;
}

interface ObservedState {
  messages: Array<{ role: string; content: string }>;
  containerStatus: string;
  isReady: boolean;
  provisioningError: string | null;
}

function mountHook(
  active: boolean,
  sessionId: string | null,
): { getState: () => ObservedState; unmount: () => void } {
  const window = (globalThis as unknown as { window: Window }).window;
  let state: ObservedState = {
    messages: [],
    containerStatus: "pending",
    isReady: false,
    provisioningError: null,
  };

  function TestHarness() {
    const result = useElizaAppProvisioningChat(active, sessionId);
    React.useEffect(() => {
      state = {
        messages: result.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        containerStatus: result.containerStatus,
        isReady: result.isReady,
        provisioningError: result.provisioningError,
      };
    });
    return React.createElement("div");
  }

  const container = window.document.getElementById("root");
  if (!container) throw new Error("root element not found");
  // Clear any previous render (container is a known empty div from setupDom)
  container.textContent = "";
  const root = createRoot(container);
  mountedRoots.add(root);
  root.render(React.createElement(TestHarness));

  let mounted = true;

  return {
    getState: () => state,
    unmount: () => {
      if (!mounted) return;
      mounted = false;
      mountedRoots.delete(root);
      root.unmount();
    },
  };
}

describe("useElizaAppProvisioningChat — shared onboarding poll", () => {
  beforeEach(() => {
    setupDom();
    fetchCalls.length = 0;
    nextStatus = "pending";
    capturedTimers = [];
    activeTimers = new Set();
  });

  afterEach(async () => {
    try {
      for (const root of mountedRoots) root.unmount();
      mountedRoots.clear();
      await waitForHostTimer();
      currentDom?.window.close();
      currentDom = null;
    } finally {
      for (const key of overriddenGlobalKeys) {
        const descriptor = originalGlobalDescriptors.get(key);
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
      // Restore every global before asserting so a single mismatch cannot
      // strand the remaining test process on the fake scheduler.
      for (const key of overriddenGlobalKeys) {
        const descriptor = originalGlobalDescriptors.get(key);
        expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(
          descriptor,
        );
      }
    }
  });

  test("the package isolates this module-mocking suite in a second Bun process", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { scripts?: { test?: string } };
    const testScript = packageJson.scripts?.test;
    expect(testScript).toBeDefined();
    expect(
      testScript?.split("tests/provisioning-poll-hook.test.ts"),
    ).toHaveLength(2);
    expect(testScript).toEndWith(
      "&& bun test tests/provisioning-poll-hook.test.ts",
    );
  });

  test("React settle waits use the host timer while the fake queue holds only poll timers", async () => {
    await waitForHostTimer();
    expect(capturedTimers).toHaveLength(0);

    const { unmount } = mountHook(true, "platform:blooio:+123****7890");
    await waitForCondition(
      () => activeTimers.size > 0,
      "the initial provisioning poll timer",
    );

    const queuedBeforeHostWait = capturedTimers.length;
    await waitForHostTimer(10);
    expect(capturedTimers).toHaveLength(queuedBeforeHostWait);
    expect(capturedTimers.every((timer) => timer.delay === POLL_DELAY_MS)).toBe(
      true,
    );

    unmount();
  });

  test("immediate poll sends statusOnly:true with no message field", async () => {
    const { unmount } = mountHook(true, "platform:blooio:+123****7890");

    // Wait for the mount effect + immediate poll to fire.
    await waitForCondition(
      () =>
        fetchCalls.some((call) => {
          const body = call.body as Record<string, unknown> | undefined;
          return body?.statusOnly === true;
        }),
      "the immediate status-only poll",
    );

    const chatCalls = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    );

    // The polling effect fires immediately on mount. That call uses
    // buildProvisioningPollBody which must carry statusOnly:true.
    const pollCalls = chatCalls.filter((c) => {
      const body = c.body as Record<string, unknown> | undefined;
      return body?.statusOnly === true;
    });

    expect(pollCalls.length).toBeGreaterThanOrEqual(1);

    // Every poll call must have statusOnly:true and must NOT have a message field
    for (const call of pollCalls) {
      const body = call.body as Record<string, unknown>;
      expect(body.statusOnly).toBe(true);
      expect(body).not.toHaveProperty("message");
    }

    // The poll body must include the sessionId and correct platform
    const firstPoll = pollCalls[0].body as Record<string, unknown>;
    expect(firstPoll.sessionId).toBe("platform:blooio:+123****7890");
    expect(firstPoll.platform).toBe("blooio");

    unmount();
  });

  test("5-second interval retry also sends statusOnly:true with no message", async () => {
    const { unmount } = mountHook(true, "platform:blooio:+123****7890");

    // Wait for mount + immediate poll.
    await waitForCondition(
      () => activeTimers.size > 0,
      "the initial provisioning poll timer",
    );

    const callsAfterImmediate = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // The hook must have registered an interval timer with 5000ms delay.
    expect(capturedTimers.length).toBeGreaterThanOrEqual(1);
    const pollTimer = capturedTimers[capturedTimers.length - 1];
    expect(pollTimer.delay).toBe(5000);

    // Fire the interval callback to simulate the 5-second tick.
    await tickPollTimers();

    // Allow the async fetch to resolve.
    await waitForCondition(
      () => pollCallCount() > callsAfterImmediate,
      "the interval-triggered poll",
    );

    const callsAfterInterval = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // At least one more call arrived after the interval tick.
    expect(callsAfterInterval).toBeGreaterThan(callsAfterImmediate);

    // The interval-triggered call(s) must carry statusOnly:true with no message.
    const intervalCalls = fetchCalls
      .filter((c) => c.url === "/api/eliza-app/onboarding/chat")
      .slice(callsAfterImmediate);

    for (const call of intervalCalls) {
      const body = call.body as Record<string, unknown>;
      expect(body.statusOnly).toBe(true);
      expect(body).not.toHaveProperty("message");
    }

    unmount();
  });

  test("repeated polls do not append duplicate assistant replies to the transcript", async () => {
    const { getState, unmount } = mountHook(
      true,
      "platform:blooio:+123****7890",
    );

    // Wait for mount + immediate poll.
    await waitForCondition(
      () => activeTimers.size > 0,
      "the initial provisioning poll timer",
    );

    // Fire multiple interval ticks to simulate several 5-second polls.
    for (let i = 0; i < 3; i++) {
      const callsBeforeTick = pollCallCount();
      await tickPollTimers();
      await waitForCondition(
        () => pollCallCount() > callsBeforeTick && activeTimers.size > 0,
        `provisioning poll ${i + 1}`,
      );
    }

    // The transcript visible to the UI must not contain duplicate assistant
    // replies from poll turns. The backend's statusOnly guard means poll
    // responses carry one welcome message array; the hook's applyOnboardingResponse
    // replaces (not appends) the messages.
    const state = getState();
    const assistantMessages = state.messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistantMessages.length).toBeLessThanOrEqual(2);

    unmount();
  });

  test("ready-state transition stops further polling", async () => {
    const { getState, unmount } = mountHook(
      true,
      "platform:blooio:+123****7890",
    );

    // Wait for mount + immediate poll (status pending).
    await waitForCondition(
      () => activeTimers.size > 0,
      "the initial provisioning poll timer",
    );

    // Flip the mock so the next response is provisioning=running with a bridgeUrl.
    nextStatus = "running";

    // Fire the interval tick — the hook should see isReady and stop polling.
    await tickPollTimers();
    await waitForCondition(
      () => getState().isReady,
      "the provisioning ready state",
    );

    // The hook must have transitioned to ready.
    expect(getState().isReady).toBe(true);

    // After the ready transition, the cleanup function should have cleared
    // the interval. Verify no new calls arrive from further ticks.
    const callsAfterReady = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // Even if we fire timers manually, cleared timers are skipped.
    await tickPollTimers();
    await waitForHostTimer();

    const callsAfterExtraTick = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // No new calls should have arrived.
    expect(callsAfterExtraTick).toBe(callsAfterReady);

    unmount();
  });

  test("cleanup on unmount stops the polling interval", async () => {
    const { unmount } = mountHook(true, "platform:blooio:+123****7890");

    // Wait for mount + immediate poll.
    await waitForCondition(
      () => activeTimers.size > 0,
      "the initial provisioning poll timer",
    );

    const callsBefore = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // Verify an interval was active.
    expect(activeTimers.size).toBeGreaterThanOrEqual(1);

    unmount();

    // After unmount, all timers should be cleared.
    const activeAfterUnmount = [...activeTimers].filter((t) => !t.cleared);
    expect(activeAfterUnmount.length).toBe(0);

    // Fire interval ticks — since they are cleared, no calls should arrive.
    await tickPollTimers();
    await waitForHostTimer();

    const callsAfter = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // No new calls should have arrived after unmount.
    expect(callsAfter).toBe(callsBefore);
  });

  test("a terminal error status stops polling and surfaces provisioningError", async () => {
    nextStatus = "error";
    const { getState, unmount } = mountHook(
      true,
      "platform:blooio:+123****7890",
    );

    await waitForCondition(
      () => getState().provisioningError !== null,
      "the terminal provisioning error",
    );

    expect(getState().provisioningError).toContain("Provisioning failed");

    const callsBefore = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // Further interval ticks must not poll again after the terminal error.
    await tickPollTimers();
    await waitForHostTimer();

    const callsAfter = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;
    expect(callsAfter).toBe(callsBefore);

    unmount();
  });

  test("the poll deadline surfaces a timeout error instead of polling forever", async () => {
    const { getState, unmount } = mountHook(
      true,
      "platform:blooio:+123****7890",
    );

    await waitForCondition(
      () => activeTimers.size > 0,
      "the initial provisioning poll timer",
    );
    expect(getState().provisioningError).toBeNull();

    const callsBefore = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;

    // Advance past the 5-minute deadline without touching the wall clock.
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60 * 1000 + 1_000;
    try {
      await tickPollTimers();
      await waitForCondition(
        () => getState().provisioningError !== null,
        "the provisioning deadline error",
      );
    } finally {
      Date.now = realNow;
    }

    expect(getState().provisioningError).toContain("timed out");

    // Polling stops after the deadline fires: the tick above must not have
    // produced a network call, and further ticks stay silent.
    const callsAfterDeadline = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;
    expect(callsAfterDeadline).toBe(callsBefore);

    await tickPollTimers();
    await waitForHostTimer();
    const callsAfterExtraTick = fetchCalls.filter(
      (c) => c.url === "/api/eliza-app/onboarding/chat",
    ).length;
    expect(callsAfterExtraTick).toBe(callsBefore);

    unmount();
  });
});
