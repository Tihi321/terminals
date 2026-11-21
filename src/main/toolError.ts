/** A user-readable tool failure. Lives in its own module (no electron/store import) so terminalHost.ts stays electron-free. */
export class ToolError extends Error {}
