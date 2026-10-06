// node:sqlite 在 Node 22/25 仍带 ExperimentalWarning。
// 该模块必须在任何 `import "node:sqlite"` 之前被求值，因此独立成文件并置于导入首位。
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (typeof text === "string" && text.includes("SQLite is an experimental feature")) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;
