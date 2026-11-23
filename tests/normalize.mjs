// Normalisation shared by the transcript tests: removes differences that are
// not behavioural (command echo formatting, trailing spaces, and the clock
// value, which the original randomises before the RNG can be seeded).
export function normalize(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\b[1-9][0-9]{3}\b/g, 'TIME')
    // After a restart the reference interpreter prints the next output on the
    // prompt line instead of echoing the command.
    .replace(/>restart\n/g, '>')
    .replace(/^>(PLANETFALL|ZORK I: The Great Underground Empire)$/gm, '>\n$1')
    .replace(/^>.*$/gm, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}
