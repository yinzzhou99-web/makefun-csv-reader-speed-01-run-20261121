// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly the answer
// csv-reader returns for {text, header} — {columns, rows, errors} — by the same
// broken-row policy, read once, left to right:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled ("" inside it is one quote; each CRLF or lone CR inside it is
//     read as LF); what follows the closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//   - a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts
//     on, counting every LF, CRLF and lone CR inside quotes, and row its
//     record's index in rows, null for the header, in the order met.
//
// Where the reference walks the text a character at a time and grows each
// field a character at a time, this reader scans for the next special
// character and slices whole clean spans out of the text at once, assembling
// a field from segments only when a stray CR, a doubled quote or a CR inside
// quotes actually splits it. Nothing is kept from one call to the next.

const COMMA = 44; // ,
const QUOTE = 34; // "
const LF = 10; // \n
const CR = 13; // \r

const ENDED_COMMA = 0;
const ENDED_BREAK = 1;
const ENDED_END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error met while reading it names both.
  let recordLine = 1;
  let recordRow = null;

  // The field the scanners just read: its value, how it ended, and — for the
  // unquoted scan — how many characters it kept (quote_junk needs it).
  let fValue = '';
  let fEnded = ENDED_END;
  let fAdded = 0;

  // Reads unquoted characters onto `prefix` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Sets fValue,
  // fEnded and fAdded, and leaves pos just past the delimiter it stopped at.
  function scanUnquoted(prefix) {
    let i = pos;
    let seg = i; // start of the clean span being scanned
    let stop = n; // where the field's text ends (the delimiter, or n)
    let parts = null; // clean spans, once a stray CR splits the field
    let end = ENDED_END;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === COMMA) {
        stop = i;
        i += 1;
        end = ENDED_COMMA;
        break;
      }
      if (c === LF) {
        stop = i;
        i += 1;
        line += 1;
        end = ENDED_BREAK;
        break;
      }
      if (c === CR) {
        if (text.charCodeAt(i + 1) === LF) {
          stop = i;
          i += 2;
          line += 1;
          end = ENDED_BREAK;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        if (seg < i) parts.push(text.slice(seg, i));
        i += 1;
        seg = i;
        continue;
      }
      i += 1;
    }
    let value;
    let added;
    if (parts === null) {
      const body = text.slice(seg, stop);
      added = body.length;
      value = prefix === '' ? body : prefix + body;
    } else {
      if (seg < stop) parts.push(text.slice(seg, stop));
      added = 0;
      for (let k = 0; k < parts.length; k++) added += parts[k].length;
      value = prefix === '' ? parts.join('') : prefix + parts.join('');
    }
    pos = i;
    fValue = value;
    fEnded = end;
    fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and
  // fEnded, and leaves pos just past the delimiter the field ended at.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let i = open + 1;
    let seg = i; // start of the clean span being scanned
    let parts = null; // clean spans, once a doubled quote or a CR splits it
    let closed = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === QUOTE) {
        if (text.charCodeAt(i + 1) === QUOTE) {
          if (parts === null) parts = [];
          parts.push(text.slice(seg, i), '"');
          i += 2;
          seg = i;
          continue;
        }
        closed = true;
        break;
      }
      if (c === CR) {
        // CRLF and a lone CR inside quotes are each read as one LF.
        if (parts === null) parts = [];
        parts.push(text.slice(seg, i), '\n');
        line += 1;
        i += text.charCodeAt(i + 1) === LF ? 2 : 1;
        seg = i;
        continue;
      }
      if (c === LF) line += 1;
      i += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      line = openLine;
      pos = open + 1;
      scanUnquoted('"');
      return;
    }
    let value;
    if (parts === null) {
      value = text.slice(seg, i);
    } else {
      if (seg < i) parts.push(text.slice(seg, i));
      value = parts.join('');
    }
    pos = i + 1; // just past the closing quote
    if (pos >= n) {
      fValue = value;
      fEnded = ENDED_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      fValue = value;
      fEnded = ENDED_COMMA;
      return;
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = ENDED_BREAK;
      return;
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = ENDED_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break (quote_junk, when anything was appended).
    scanUnquoted(value);
    if (fAdded > 0) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    for (;;) {
      if (text.charCodeAt(pos) === QUOTE) {
        lastQuoted = true;
        scanQuoted();
      } else {
        lastQuoted = false;
        scanUnquoted('');
      }
      fields.push(fValue);
      if (fEnded !== ENDED_COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
