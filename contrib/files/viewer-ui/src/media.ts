import { useEffect, useState } from "react";

/** Tracks a media query, re-rendering when it flips. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const update = () => setOn(m.matches);
    update();
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, [query]);
  return on;
}

// Tailwind's `md`: below it the tree and comments become overlays.
export const useNarrow = () => useMedia("(max-width: 767.98px)");
