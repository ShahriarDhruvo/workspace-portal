/** `run`, one at a time: a call made while a run is under way joins it (its own arguments are not used). */
export function singleFlight<A extends unknown[], T>(run: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let flight: Promise<T> | null = null;
  return (...args) =>
    (flight ??= run(...args).finally(() => {
      flight = null;
    }));
}
