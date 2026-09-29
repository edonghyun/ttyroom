/** Print a marker absent from the input itself, so terminal echo cannot satisfy the assertion. */
export function printMarker(marker: string): string {
  const middle = Math.ceil(marker.length / 2);
  return `printf '%s%s\\n' ${quote(marker.slice(0, middle))} ${quote(marker.slice(middle))}\n`;
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
