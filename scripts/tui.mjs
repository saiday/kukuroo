//
// The full-screen half of `kukuroo init`.
//
// The questions take over the terminal so that each one is on screen by itself,
// with the reason it matters next to it rather than scrolled off above. What the
// questions decide is hard to undo later, and the old flow printed four
// paragraphs of explanation and a `[1/2]` prompt into a scrollback that had
// already lost the first two.
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

/** Nothing here works down a pipe, and pretending otherwise hangs the run. */
export function supported() {
  return Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      typeof process.stdin.setRawMode === "function",
  );
}

/**
 * Text columns to lay out against.
 *
 * Clamped at both ends: below 40 the wrapped prose turns into a column of single
 * words, and above 88 the eye loses the line it is on between one row and the
 * next. A terminal reporting nothing gets the conventional 80.
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

const PAD = "  ";

/**
 * The whole screen, as a string.
 *
 * Rules rather than a drawn box. A box has to know the terminal's width exactly
 * and stays right only until something wraps; a rule that is a few columns short
 * is merely a rule that is a few columns short.
 */
export function renderFrame({
  step,
  total,
  question,
  body = "",
  choices = null,
  cursor = 0,
  value = null,
  error = "",
  cols = columns(),
}) {
  const inner = cols - PAD.length * 2;
  const rule = "─".repeat(inner);
  const out = [];

  const counter = step === null ? "" : `question ${step} of ${total}`;
  out.push(PAD + "kukuroo init" + " ".repeat(Math.max(1, inner - 12 - counter.length)) + counter);
  out.push(PAD + rule);
  out.push("");
  out.push(...wrap(question, inner).map((l) => PAD + l));
  out.push("");

  if (body !== "") {
    out.push(...wrap(body, inner).map((l) => PAD + l));
    out.push("");
  }

  if (choices !== null) {
    choices.forEach((choice, i) => {
      const marker = i === cursor ? "▸ " : "  ";
      out.push(`${PAD}  ${marker}${choice.label}`);
      // Four, not five: the label sits past a two-column marker, and the hint
      // lines up under the label rather than under the marker.
      if (choice.hint) {
        out.push(...wrap(choice.hint, inner - 4).map((l) => `${PAD}    ${l}`));
      }
      if (i < choices.length - 1) out.push("");
    });
    out.push("");
  }

  if (value !== null) {
    // A block for a cursor, because the real one is hidden for the whole session:
    // leaving it visible parks it wherever the last write happened to end.
    out.push(`${PAD}  ${value}█`);
    out.push("");
  }

  if (error !== "") {
    out.push(...wrap(error, inner).map((l) => PAD + l));
    out.push("");
  }

  // The key help is the only line with a fixed length, so it is the only one that
  // can overrun a narrow terminal and wrap the rule underneath it. Two forms.
  const help = choices !== null
    ? inner >= 50
      ? "↑ ↓ or 1-9 to choose    ⏎ to confirm    ^C to stop"
      : "↑ ↓ choose   ⏎ confirm   ^C stop"
    : inner >= 34
      ? "⏎ to confirm    ^C to stop"
      : "⏎ confirm   ^C stop";

  out.push(PAD + rule);
  out.push(PAD + help);

  return out.join("\n") + "\n";
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
 * Ask one question and resolve with its answer.
 *
 * A choice question resolves with the chosen entry's `value`; a text question
 * resolves with the trimmed string, having refused to resolve at all while
 * `validate` is still returning a complaint.
 */
export function ask(spec) {
  return new Promise((resolve, reject) => {
    let cursor = spec.default ?? 0;
    let value = "";
    let error = "";
    const choices = spec.choices ?? null;

    const draw = () => {
      process.stdout.write(
        CSI + "H" + CSI + "2J" +
          renderFrame({
            step: spec.step,
            total: spec.total,
            question: spec.question,
            body: spec.body ?? "",
            choices,
            cursor,
            value: choices === null ? value : null,
            error,
          }),
      );
    };

    const finish = (fn, arg) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
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

  out.write(CSI + "?1049h" + CSI + "?25l");
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
