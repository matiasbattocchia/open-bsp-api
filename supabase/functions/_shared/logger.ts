type LogLevel = "info" | "warn" | "error";

const levelColor: Record<LogLevel, string> = {
  info: "blue",
  warn: "yellow",
  error: "red",
};

function log(level: LogLevel, message: string, details?: unknown): void {
  const color = levelColor[level];

  if (typeof details === "string") {
    console[level](
      `%c${message}\n%c${details}`,
      `color: ${color}`,
      `color: ${color}; font-weight: bold`
    );
  } else if (details != null) {
    console[level](`%c${message}\n`, `color: ${color}`, details);
  } else {
    console[level](`%c${message}`, `color: ${color}`);
  }
}

export function info(message: string, details?: unknown): void {
  log("info", message, details);
}

export function warn(message: string, details?: unknown): void {
  log("warn", message, details);
}

export function error(message: string, details?: unknown): void {
  log("error", message, details);
}
