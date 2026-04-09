/**
 * Format a host and port into a network address string.
 * @param ip
 * @param port
 * @returns Formatted network address.
 */
export function formatIP(ip: string, port: number): string {
  return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
}
