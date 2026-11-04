// A short name for the phone or computer behind a session ("Chrome · Android 14"), for Profil's list of signed-in
// devices. Only this label is stored, never the full user-agent string.

export function deviceLabel(ua: string | undefined): string | null {
  if (!ua) return null;
  const android = ua.match(/Android (\d+)/);
  const ios = ua.match(/(iPhone|iPad)[^)]*OS (\d+)/);
  const os = android
    ? `Android ${android[1]}`
    : ios
      ? `${ios[1]} iOS ${ios[2]}`
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  // order matters: Edge, Samsung and Opera also say Chrome; Chrome on iPhone says Safari
  const browser = /EdgA?\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser\//.test(ua)
      ? 'Samsung Internet'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /CriOS\/|Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  const label = [browser, os].filter(Boolean).join(' · ');
  return label || null;
}
