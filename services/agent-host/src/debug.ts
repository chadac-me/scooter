/** Tiny debug logger, on only when DEBUG=1 or AGENT_HOST_DEBUG=1. */
const ON = process.env.DEBUG === "1" || process.env.AGENT_HOST_DEBUG === "1";

export const debug = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  if (ON) console.log(...args);
};

/** Non-fatal errors worth surfacing, always logged. */
export const debugError = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error(...args);
};
