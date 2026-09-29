/** Local tooling only: bound graceful pg.Client close; forced close remains reported as uncertain. */
export interface OwnedPgConnection {
  end(): unknown;
  connection?: { stream?: { destroy(): unknown } };
}
export function closeOwnedPgClient(
  client: OwnedPgConnection,
): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (clean: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (!clean) {
        try {
          client.connection?.stream?.destroy();
        } catch {
          /* uncertainty is retained */
        }
      }
      resolve(clean);
    };
    const timer = setTimeout(() => finish(false), 5000);
    Promise.resolve()
      .then(() => client.end())
      .then(
        () => finish(true),
        () => finish(false),
      );
  });
}
