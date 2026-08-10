//
// The full-screen half of `kukuroo init`.
//
// The questions take over the terminal so that each one is on screen by itself,
// with the reason it matters next to it rather than scrolled off above. What the
// questions decide is hard to undo later, and the old flow printed four
// paragraphs of explanation and a `[1/2]` prompt into a scrollback that had
// already lost the first two.
//
// It fills the screen, in the sense whiptail installers do: every cell is
// painted, a bar across the top says which program is asking and how far in you
// are, a bar across the bottom says which keys do what, and the question sits in
// a measured column between them. Content stretched edge to edge would be the
// other reading and the wrong one -- prose is unreadable at 200 columns -- so
// what fills the width is the frame, and what stays narrow is the text.
//
// The work that follows the questions is deliberately *not* in here. `npm
// install` and `wrangler deploy` keep streaming to the normal screen, because a
// deploy that fails does so by saying something specific, and a progress pane
// that swallowed it would cost the operator the one thing they need at the one
// moment they need it.
//
// The split in this file is between rendering and input. `renderFrame` is a pure
// function from state to a string, so the layout can be tested without a
// terminal; `ask` is the loop that owns the keyboard and does nothing else.
//

const CSI = "\x1b[";
const BOLD = CSI + "1m";
const DIM = CSI + "2m";
const REVERSE = CSI + "7m";
const OFF = CSI + "0m";

/** Nothing here works down a pipe, and pretending otherwise hangs the run. */
export function supported() {
  return Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      typeof process.stdin.setRawMode === "function",
  );
}

/** Escape sequences carry no width. Everything that measures a line goes through here. */
export const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const visible = (text) => [...plain(text)].length;
const padTo = (text, width) => text + " ".repeat(Math.max(0, width - visible(text)));

/**
 * Exactly `width` visible columns: padded out if short, cut off if long.
 *
 * The cut is the guarantee, not the plan. Everything above wraps to the measure
 * and should never reach here over-long, but `wrap` leaves an unbreakable token
 * whole rather than splitting it, and one 60-character token in a 40-column
 * terminal would otherwise wrap the frame, shift every row below it by one, and
 * push the key help off the bottom of the screen. Escapes are carried through and
 * cost nothing, since they occupy no columns.
 */
function fit(text, width) {
  if (visible(text) <= width) return padTo(text, width);
  let out = "";
  let used = 0;
  for (let i = 0; i < text.length && used < width; ) {
    const escape = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
    if (escape !== null) {
      out += escape[0];
      i += escape[0].length;
      continue;
    }
    // By code point: the frame's own glyphs are all in the basic plane, but the
    // operator's hostname arrives from a keyboard and need not be.
    const character = String.fromCodePoint(text.codePointAt(i));
    out += character;
    i += character.length;
    used += 1;
  }
  return out + OFF;
}

/**
 * The terminal, as something to lay out in.
 *
 * Both are clamped at the bottom rather than trusted. A terminal that reports
 * nothing gets the conventional 80x24, and one that reports 4 rows gets a frame
 * that overflows tidily instead of arithmetic that goes negative.
 */
export function screen(cols = process.stdout.columns, lines = process.stdout.rows) {
  return { cols: Math.max(cols || 80, 30), lines: Math.max(lines || 24, 10) };
}

/**
 * Text columns to lay out against, for the line-by-line asker.
 *
 * Clamped at both ends: below 40 the wrapped prose turns into a column of single
 * words, and above 88 the eye loses the line it is on between one row and the
 * next. A terminal reporting nothing gets the conventional 80.
 *
 * The full-screen frame does its own arithmetic and does not go through here. It
 * has a width it must fill exactly and a measured column inside that width, and
 * those are two numbers rather than one.
 */
export function columns(reported = process.stdout.columns) {
  return Math.min(Math.max(reported || 80, 40), 88);
}

/** Greedy word wrap. Long unbreakable tokens are left over-long rather than cut. */
export function wrap(text, cols) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line === "") line = word;
      else if (`${line} ${word}`.length <= cols) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

const GUTTER = 2;
const PAD = " ".repeat(GUTTER);

/**
 * The key help, in as long a form as fits.
 *
 * Longest first, and the first form that fits wins. This is the only line in the
 * frame whose length it did not choose, so it is the only one that can overrun a
 * narrow terminal, and a help line that wraps pushes the bottom bar off screen.
 */
function helpLine(inner, { picking, canGoBack }) {
  const forms = [
    { sep: "    ", parts: ["↑ ↓ or 1-9 to choose", "⏎ to confirm", "← to go back", "^C to stop"] },
    { sep: "    ", parts: ["↑ ↓ or 1-9 to choose", "⏎ to confirm", "← back", "^C to stop"] },
    { sep: "   ", parts: ["↑ ↓ choose", "⏎ confirm", "← back", "^C stop"] },
    { sep: "  ", parts: ["↑↓ choose", "⏎ ok", "← back", "^C stop"] },
  ];

  // A text question has nothing to choose between, so the first segment goes. A
  // first question has nothing to go back to, so that one goes too: a key in the
  // help line that does nothing is worse than a key that was never mentioned.
  //
  // Then, if even the shortest wording will not fit, segments start going for
  // width instead, least useful first. Choosing and going back are discoverable
  // by trying them; the one that has to survive is how to get out.
  const passes = [
    (part, i) => (i > 0 || picking) && (canGoBack || !part.startsWith("←")),
    (part, i) => i > 0 && (canGoBack || !part.startsWith("←")),
    (part, i) => i > 1 && !part.startsWith("←"),
  ];

  let last = "";
  for (const keep of passes) {
    for (const { sep, parts } of forms) {
      last = parts.filter(keep).join(sep);
      if (visible(last) <= inner) return last;
    }
  }
  return [...last].slice(0, inner).join("");
}

/** A full-width bar: program on the left, position on the right, painted through. */
function bar(left, right, cols) {
  const gap = cols - GUTTER * 2 - visible(left) - visible(right);
  const line = gap < 1 ? PAD + left : PAD + left + " ".repeat(gap) + right;
  return REVERSE + padTo(line, cols) + OFF;
}

/**
 * The whole screen, as a string.
 *
 * Every line is padded to the full width and the block is padded to the full
 * height, so a redraw can overwrite the previous frame cell for cell without
 * clearing first. Clearing between frames is what makes a full-screen TUI flicker
 * while somebody types a hostname into it.
 */
export function renderFrame({
  step,
  total,
  question,
  body = "",
  status = "",
  facts = null,
  choices = null,
  cursor = 0,
  value = null,
  placeholder = "",
  error = "",
  canGoBack = false,
  cols = screen().cols,
  lines = screen().lines,
}) {
  // The measured column, and where it starts. Centred, so a wide terminal puts
  // the question in the middle of the screen rather than against its left edge.
  const inner = Math.min(cols - GUTTER * 2, 88);
  const left = " ".repeat(Math.max(GUTTER, Math.floor((cols - inner) / 2)));
  const out = [];

  // A fact about the whole session rather than about this question, and still
  // part of the block: pinned to the top bar instead, it sat a screenful of
  // blank rows above the question it qualifies and read as belonging to the
  // chrome. It leads the block because it is the context the question is asked
  // in, and it is dim because it is not the thing being asked.
  if (status !== "") {
    out.push(...wrap(status, inner).map((l) => left + DIM + l + OFF));
    out.push("");
  }

  out.push(...wrap(question, inner).map((l) => left + BOLD + l + OFF));
  out.push("");

  if (body !== "") {
    out.push(...wrap(body, inner).map((l) => left + l));
    out.push("");
  }

  if (facts !== null) {
    const width = Math.max(...facts.map(([label]) => visible(label)));
    // The values wrap under themselves rather than under their label, and a
    // narrow terminal is exactly where they need to: these are whole phrases,
    // not words, and one of them running past the frame takes the bottom bar
    // with it.
    const room = Math.max(8, inner - 2 - width - 3);
    for (const [label, detail] of facts) {
      wrap(detail, room).forEach((line, i) => {
        const head =
          i === 0
            ? DIM + label + OFF + " ".repeat(width - visible(label))
            : " ".repeat(width);
        out.push(`${left}  ${head}   ${line}`);
      });
    }
    out.push("");
  }

  if (choices !== null) {
    choices.forEach((choice, i) => {
      const chosen = i === cursor;
      // The marker sits in the gutter, so a label that wraps carries on under
      // itself rather than under the arrow.
      wrap(choice.label, inner - 4).forEach((line, j) => {
        const marker = j === 0 && chosen ? "▸ " : "  ";
        out.push(`${left}  ${marker}${chosen ? BOLD + line + OFF : line}`);
      });
      // Four, not five: the label sits past a two-column marker, and the hint
      // lines up under the label rather than under the marker.
      if (choice.hint) {
        out.push(...wrap(choice.hint, inner - 4).map((l) => `${left}    ${DIM}${l}${OFF}`));
      }
      if (i < choices.length - 1) out.push("");
    });
    out.push("");
  }

  if (value !== null) {
    // A block for a cursor, because the real one is hidden for the whole session:
    // leaving it visible parks it wherever the last write happened to end.
    //
    // A field longer than the frame shows its end. That is where the cursor is
    // and where the typing is happening, and a field that showed its beginning
    // would stop moving under the operator's hands halfway through a hostname.
    const room = Math.max(8, inner - 3);
    const typed = [...value];
    const shown = typed.length > room ? "…" + typed.slice(1 - room).join("") : value;
    // The example is a ghost: there to be read while the field is empty, gone the
    // moment there is a real answer occupying the same columns.
    const ghost =
      value === "" && placeholder !== ""
        ? DIM + [...placeholder].slice(0, room).join("") + OFF
        : "";
    out.push(`${left}  ${shown}█${ghost}`);
    out.push("");
  }

  if (error !== "") {
    out.push(...wrap(error, inner).map((l) => left + BOLD + l + OFF));
    out.push("");
  }

  // Trailing blank lines are the block's own spacing, not part of its height.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  // A terminal too short for the question loses the end of it. Which is bad, and
  // still the better of the two: the alternative is a block that overruns the
  // last row, scrolls the frame, and takes the key help off the bottom of the
  // screen, leaving somebody stuck in a full-screen program with no visible way
  // out of it. The ellipsis is there so the loss is something they can see.
  const room = Math.max(0, lines - 2);
  if (out.length > room) {
    out.length = Math.max(0, room - 1);
    out.push(left + DIM + "…" + OFF);
  }

  // Centred between the bars, which is what the whiptail and dialog installers
  // this borrows its shape from do with the box they draw. Those size the box to
  // its content and centre it in a painted screen rather than stretching it, on
  // the grounds that a small box reads better than a large one full of air; the
  // column measure above is the same idea without the box.
  const free = Math.max(0, lines - 2 - out.length);
  const above = Math.floor(free / 2);

  return [
    bar("kukuroo init", step === null ? "" : `question ${step} of ${total}`, cols),
    ...Array(above).fill(""),
    ...out,
    ...Array(free - above).fill(""),
    bar(helpLine(cols - GUTTER * 2, { picking: choices !== null, canGoBack }), "", cols),
  ]
    .map((line) => fit(line, cols))
    // No trailing newline. Writing one after the last row scrolls the frame up
    // by a line in every terminal that autowraps, which is all of them.
    .join("\n");
}

/**
 * Split one stdin chunk into individual keys.
 *
 * A chunk is not a keystroke. Typing quickly, holding a key down, or pasting a
 * hostname all deliver several at once, and an arrow key is three bytes that must
 * stay together. Treating the chunk as a single key drops most of a paste and
 * ignores anything with a newline on the end of it.
 */
export function keysOf(chunk) {
  const keys = [];
  const printable = (c) => c >= "\x20" && c !== "\x7f";
  for (let i = 0; i < chunk.length; ) {
    if (/^\x1b\[[A-D]$/.test(chunk.slice(i, i + 3))) {
      keys.push(chunk.slice(i, i + 3));
      i += 3;
    } else if (!printable(chunk[i])) {
      keys.push(chunk[i]);
      i += 1;
    } else {
      let end = i;
      while (end < chunk.length && printable(chunk[end])) end += 1;
      keys.push(chunk.slice(i, end));
      i = end;
    }
  }
  return keys;
}

/** Thrown when the operator stops the run, so callers can say so in their own words. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/**
 * What `ask` resolves with when the operator wants the previous question back.
 *
 * A symbol rather than a string or null, because a choice's `value` is whatever
 * the caller put there, and this has to be a value no answer can collide with.
 */
export const BACK = Symbol("back");

/**
 * Ask one question and resolve with its answer.
 *
 * A choice question resolves with the chosen entry's `value`; a text question
 * resolves with the trimmed string, having refused to resolve at all while
 * `validate` is still returning a complaint. Either resolves with BACK when
 * `canGoBack` and the operator asks for the previous question.
 */
export function ask(spec) {
  return new Promise((resolve, reject) => {
    let cursor = spec.default ?? 0;
    let value = spec.value ?? "";
    let error = "";
    const choices = spec.choices ?? null;
    const canGoBack = spec.canGoBack === true;

    const draw = () => {
      const { cols, lines } = screen();
      process.stdout.write(
        CSI + "H" +
          renderFrame({
            step: spec.step,
            total: spec.total,
            question: spec.question,
            body: spec.body ?? "",
            status: spec.status ?? "",
            facts: spec.facts ?? null,
            choices,
            cursor,
            value: choices === null ? value : null,
            placeholder: spec.placeholder ?? "",
            error,
            canGoBack,
            cols,
            lines,
          }),
      );
    };

    const finish = (fn, arg) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdout.off("resize", draw);
      fn(arg);
    };

    // Ctrl+D, or a stdin that was a pipe after all. Without this the promise
    // never settles, node runs out of work, and the process leaves with status 0
    // having asked a question, taken no answer, and said nothing about either.
    const onEnd = () => finish(reject, new Cancelled());

    /** Apply one key. Returns true once the question is answered and done with. */
    function handle(key) {
      if (key === "\x03") {
        finish(reject, new Cancelled());
        return true;
      }

      // Left or Escape steps back a question. Left is not in use inside the text
      // field either: there is no cursor to move, only a backspace.
      if (canGoBack && (key === CSI + "D" || key === "\x1b")) {
        finish(resolve, BACK);
        return true;
      }

      if (key === "\r" || key === "\n") {
        if (choices !== null) {
          finish(resolve, choices[cursor].value);
          return true;
        }
        const answer = value.trim();
        const complaint = spec.validate ? spec.validate(answer) : null;
        if (complaint === null || complaint === undefined) {
          finish(resolve, answer);
          return true;
        }
        error = `${complaint}.`;
        return false;
      }

      if (choices !== null) {
        if (key === CSI + "A") cursor = (cursor - 1 + choices.length) % choices.length;
        else if (key === CSI + "B") cursor = (cursor + 1) % choices.length;
        else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) cursor = Number(key) - 1;
        return false;
      }

      if (key === "\x7f" || key === "\b") {
        value = value.slice(0, -1);
        error = "";
        return false;
      }
      // Printable only. Escape sequences and control characters would otherwise
      // arrive as text and quietly become part of a hostname.
      if (/^[\x20-\x7e]+$/.test(key)) {
        value += key;
        error = "";
      }
      return false;
    }

    function onData(chunk) {
      for (const key of keysOf(chunk.toString("utf8"))) {
        if (handle(key)) return;
      }
      draw();
    }

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    // A frame sized to the terminal is wrong the moment the terminal is not that
    // size any more, and the operator is the one who resized it, so they are
    // watching when it happens.
    process.stdout.on("resize", draw);
    draw();
  });
}

/**
 * Run `fn` with the terminal handed over, and give it back afterwards.
 *
 * Every exit restores, including the ones nobody chose. A process that dies in
 * the alternate screen with the cursor hidden leaves the operator with a terminal
 * that looks broken and no obvious way to tell that it is not.
 */
export async function withScreen(fn) {
  const out = process.stdout;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Already closed, or never a TTY. Either way there is nothing to reset.
    }
    process.stdin.pause();
    out.write(CSI + "?25h" + CSI + "?1049l");
  };
  const onSignal = (code) => () => {
    restore();
    process.exit(code);
  };
  const onInt = onSignal(130);
  const onTerm = onSignal(143);

  process.on("exit", restore);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  // Cleared once, on the way in. After this every frame paints every cell, so
  // the redraws overwrite rather than blank-and-repaint.
  out.write(CSI + "?1049h" + CSI + "?25l" + CSI + "2J" + CSI + "H");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    return await fn();
  } finally {
    restore();
    process.off("exit", restore);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
