const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface SanitizeTextOptions {
  maxLength: number;
  collapseWhitespace?: boolean;
}

export function sanitizeText(value: string, options: SanitizeTextOptions): string {
  const withoutControls = value.replace(CONTROL_CHARACTERS, " ");
  const normalized = options.collapseWhitespace === false
    ? withoutControls.trim()
    : withoutControls.replace(/\s+/g, " ").trim();

  if (normalized.length <= options.maxLength) {
    return normalized;
  }

  if (options.maxLength <= 1) {
    return normalized.slice(0, options.maxLength);
  }

  return `${normalized.slice(0, options.maxLength - 1)}…`;
}
