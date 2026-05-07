export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delayMs);
  };
}

export function fileContextValue(nameOrPath: string, options: { deleted?: boolean } = {}): string {
  return ['file', options.deleted ? 'deleted' : undefined, 'ext', extensionSegment(nameOrPath)]
    .filter((part): part is string => !!part)
    .join('.');
}

export function fileTabContextValue(
  nameOrPath: string,
  options: { grouped?: boolean } = {},
): string {
  return [
    'tab',
    'file',
    'ext',
    extensionSegment(nameOrPath),
    options.grouped ? 'grouped' : undefined,
  ]
    .filter((part): part is string => !!part)
    .join('.');
}

export function typedTabContextValue(type: string, options: { grouped?: boolean } = {}): string {
  return ['tab', 'type', contextSegment(type), options.grouped ? 'grouped' : undefined]
    .filter((part): part is string => !!part)
    .join('.');
}

export function isVsixFileName(name: string): boolean {
  return extensionSegment(name) === 'vsix';
}

function extensionSegment(nameOrPath: string): string {
  const name = baseNameFromPath(nameOrPath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'none';
  return contextSegment(name.slice(dot + 1));
}

function baseNameFromPath(nameOrPath: string): string {
  const slash = Math.max(nameOrPath.lastIndexOf('/'), nameOrPath.lastIndexOf('\\'));
  return slash >= 0 ? nameOrPath.slice(slash + 1) : nameOrPath;
}

function contextSegment(value: string): string {
  return (
    value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'
  );
}
