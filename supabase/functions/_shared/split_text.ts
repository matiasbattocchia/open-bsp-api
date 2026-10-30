/**
 * Splits a text into pieces of at most `limit` characters, counted as
 * Postgres counts them (code points, not UTF-16 units). Each cut falls on the
 * last paragraph break, line break, sentence end or space in the second half
 * of the piece, and mid-word only when there is none.
 */
export function splitText(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;

  while ([...rest].length > limit) {
    const window = [...rest].slice(0, limit).join("");
    const cut = ["\n\n", "\n", ". ", " "]
      .map((separator) => window.lastIndexOf(separator) + separator.length)
      .find((end) => end > window.length / 2) ?? window.length;

    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest) pieces.push(rest);

  return pieces.filter(Boolean);
}
