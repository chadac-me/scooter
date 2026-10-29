/**
 * Error boundary around the assistant-ui Thread. The runtime can throw a transient
 * internal error when the render pump's runtime.thread.reset() shrinks or reorders the
 * message list while assistant-ui is mid-render holding a stale index. The boundary
 * clears its error whenever `resetKey` changes (the render pump bumps it on every
 * message change), so the next consistent render re-mounts the Thread.
 */

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Bumped by the parent on every message change; a change clears the error and re-mounts the Thread. */
  resetKey: unknown;
}

interface State {
  error: unknown;
}

export class ThreadErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // resetKey changed: clear the error and try again.
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: unknown) {
    // A persistent crash should still be diagnosable.
    console.warn("[ui] Thread render error (recovering on next update):", error);
  }

  render() {
    // While errored, render nothing until resetKey advances.
    return this.state.error !== null ? null : this.props.children;
  }
}
