export async function deliverClientSession(
  send: () => Promise<{ status: number }>,
  attempts = 2,
): Promise<void> {
  let lastFailure = 'unknown failure';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await send();
      if (response.status === 200) return;
      lastFailure = `status=${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`MCP connection could not be recorded: ${lastFailure}`);
}
