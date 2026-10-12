// The default Device record display name, "<browser> on <system>" (D30). Read from the user agent
// only to name the device; never used to pick a layout (D15).

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export function deviceName(userAgent: string): string {
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1] ?? 'Browser';
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  return system ? `${browser} on ${system}` : browser;
}
