// The full-screen questions, tested where they can be: the layout is a pure
// function from state to a string, and the key decoding is a pure function from a
// stdin chunk to a list of keys. Neither needs a terminal, which is the whole
// reason they are separated from the loop that owns one.
import { columns, keysOf, plain, renderFrame, screen, wrap } from "../scripts/tui.mjs";

const ok = (label, cond) => {
  console.log(`${cond ? "  ok" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

// ---------------------------------------------------------------------------
// keysOf. A chunk is not a keystroke: holding a key down, typing quickly, and
// pasting all deliver several at once, and an arrow is three bytes that have to
// survive as one.

ok("a single printable run is one key", keysOf("abc").join("|") === "abc");
ok("an arrow stays whole", keysOf("\x1b[B").join("|") === "\x1b[B");
ok("arrows and a return split apart",
  keysOf("\x1b[B\x1b[A\r").join("|") === "\x1b[B|\x1b[A|\r");
ok("a pasted hostname with a newline yields both",
  keysOf("push.example.com\r").join("|") === "push.example.com|\r");
ok("backspace is its own key", keysOf("ab\x7f").join("|") === "ab|\x7f");
ok("ctrl-C is not swallowed by the text beside it",
  keysOf("x\x03").join("|") === "x|\x03");
ok("an empty chunk yields nothing", keysOf("").length === 0);

// ---------------------------------------------------------------------------
// wrap and columns.

ok("wrap breaks on the column", wrap("aaa bbb ccc", 7).join("|") === "aaa bbb|ccc");
ok("wrap keeps a blank line between paragraphs",
  wrap("a\n\nb", 10).join("|") === "a||b");
ok("wrap leaves an unbreakable token over-long rather than cutting it",
  wrap("short verylongunbreakabletoken", 8).join("|") === "short|verylongunbreakabletoken");
ok("columns clamps a narrow terminal up", columns(20) === 40);
ok("columns clamps a wide terminal down", columns(200) === 88);
ok("columns takes a reasonable width as given", columns(74) === 74);
ok("columns falls back to 80 when the terminal reports nothing", columns(undefined) === 80);

// ---------------------------------------------------------------------------
// screen. The frame is sized to the terminal, so a terminal that reports
// nonsense has to produce a frame rather than negative arithmetic.

ok("screen falls back to 80x24", screen(undefined, undefined).cols === 80 &&
  screen(undefined, undefined).lines === 24);
ok("screen refuses to go below a usable floor",
  screen(4, 2).cols === 30 && screen(4, 2).lines === 10);
ok("screen takes a real terminal as given",
  screen(120, 40).cols === 120 && screen(120, 40).lines === 40);

// ---------------------------------------------------------------------------
// renderFrame.
//
// Every assertion about width goes through `plain`, because the frame is
// coloured and an escape sequence occupies no columns. Measuring the raw string
// would report a frame three times too wide and pass every test that mattered.

const rows = (rendered) => rendered.split("\n").map(plain);
const widest = (rendered) => Math.max(...rows(rendered).map((l) => [...l].length));

const choices = [
  { label: "A workers.dev address", hint: "Free, and stable while the name holds.", value: "wd" },
  { label: "A domain on Cloudflare", hint: "The deploy provisions DNS.", value: "dom" },
];
const frame = (over = {}) =>
  renderFrame({ step: 2, total: 3, question: "Where will devices enroll?", body: "Pick one.",
    choices, cursor: 0, cols: 74, lines: 24, ...over });

const first = frame();
ok("the header counts the question", plain(first).includes("question 2 of 3"));
ok("the cursor marks the current choice", plain(first).includes("▸ A workers.dev address"));
ok("the other choice carries no marker", plain(first).includes("  A domain on Cloudflare"));
ok("a choice question says how to choose", plain(first).includes("↑ ↓ or 1-9 to choose"));

const second = frame({ cursor: 1 });
ok("moving the cursor moves the marker",
  plain(second).includes("▸ A domain on Cloudflare") &&
  !plain(second).includes("▸ A workers.dev address"));

// A hint indented past its own label reads as belonging to the next one.
const labelColumn = rows(first).find((l) => l.includes("A workers.dev address")).indexOf("A workers");
const hintColumn = rows(first).find((l) => l.includes("Free, and stable")).indexOf("Free,");
ok("hints line up under their label, not under the marker", labelColumn === hintColumn);

const typed = renderFrame({ step: 2, total: 3, question: "Which hostname?", body: "No scheme.",
  value: "push.example.com", cols: 74, lines: 24 });
ok("a text question shows what has been typed", plain(typed).includes("push.example.com█"));
ok("a text question offers no choice keys", !plain(typed).includes("to choose"));
ok("a text question still says how to confirm", plain(typed).includes("⏎ to confirm"));
ok("no choices are rendered when there are none", !plain(typed).includes("▸"));

// The example is a ghost: it is there to be read while the field is empty and
// gone the moment there is a real answer occupying the same columns.
const empty = renderFrame({ step: 2, total: 3, question: "Which hostname?", body: "No scheme.",
  value: "", placeholder: "push.example.com", cols: 74, lines: 24 });
ok("an empty field shows the example", plain(empty).includes("█push.example.com"));
ok("the example is not there once something is typed",
  !plain(renderFrame({ step: 2, total: 3, question: "Which hostname?", body: "No scheme.",
    value: "a", placeholder: "push.example.com", cols: 74, lines: 24 })).includes("push.example.com"));

const complained = renderFrame({ step: 1, total: 3, question: "Which hostname?", body: "No scheme.",
  value: "https://x.example.com", error: "just the hostname, with no https:// in front.",
  cols: 74, lines: 24 });
ok("a complaint is shown with the value that caused it",
  plain(complained).includes("just the hostname, with no https:// in front.") &&
  plain(complained).includes("https://x.example.com█"));

// The frame is the screen: every row is the full width and there are exactly as
// many rows as the terminal has. Short of that it does not fill; over it, the
// bottom bar scrolls off and takes the key help with it.
for (const [label, rendered] of [["choices", first], ["text", complained]]) {
  const lengths = rows(rendered).map((l) => [...l].length);
  ok(`the ${label} frame fills all 24 rows`, lengths.length === 24);
  ok(`the ${label} frame fills every row to 74 columns`,
    lengths.every((n) => n === 74));
}
ok("the frame ends without a trailing newline", !first.endsWith("\n"));

const short = renderFrame({ step: 1, total: 2, question: "Where will devices enroll?",
  body: "Moving it later means every device enrolls again by hand.", choices, cursor: 0,
  cols: 40, lines: 40 });
ok(`a 40-column terminal still fits (${widest(short)} <= 40)`, widest(short) <= 40);
ok("a 40-row terminal gets 40 rows", rows(short).length === 40);
ok("a narrow terminal falls back to short key help", plain(short).includes("⏎ confirm"));

// The session line: which account all of this is about to happen to. It leads
// the block rather than hanging off the top bar, because up there a tall
// terminal put a screenful of blank rows between it and the question it
// qualifies, and a line that far from what it describes reads as chrome.
const STATUS = "Cloudflare account: Feocms@gmail.com's Account";
const standing = rows(frame({ status: STATUS }));
const statusRow = standing.findIndex((l) => l.includes(STATUS));
const questionRow = standing.findIndex((l) => l.includes("Where will devices enroll?"));
ok("the session line is on screen", statusRow !== -1);
ok("it sits immediately above the question, one blank line apart",
  questionRow === statusRow + 2 && standing[statusRow + 1].trim() === "");
ok("it travels with the block rather than with the top bar", standing[1].trim() === "");
ok("nothing is drawn when there is nothing to say", !plain(first).includes("Cloudflare account"));
ok("the line costs the content a row, not the frame",
  standing.length === 24 && standing.every((l) => [...l].length === 74));

// Back is offered only where there is something behind you. A key in the help
// line that does nothing is worse than a key that was never mentioned.
ok("no way back is advertised on the first question", !plain(first).includes("←"));
ok("a way back is advertised once there is one",
  plain(frame({ canGoBack: true })).includes("← to go back"));

// Filling the screen is the whole claim, so it is checked at every size rather
// than at the one the author happened to have open. A frame one row too tall
// scrolls, which takes the bottom bar and the only printed way out with it; a
// line one column too wide wraps and does the same thing.
{
  const specimens = [
    { question: "Use the bundled front end?",
      body: "Something has to serve the page a phone opens in Safari, adds to the Home " +
        "Screen, and enrolls from.", choices, cursor: 0 },
    { question: "Which hostname?", body: "No scheme, no path, no port.",
      value: "a-very-long-unbreakable-hostname-nobody-would-actually-type.example.com",
      error: "that does not look like a hostname." },
    { question: "Which hostname?", body: "No scheme.", value: "", placeholder: "push.example.com" },
    { question: "Ready?", body: "Last look before anything is created.",
      facts: [["Front end", "the bundled enrollment page"],
              ["Enroll on", "a workers.dev address, named by the first deploy"]],
      choices, cursor: 1 },
    // The standing line takes a row off the top, which the centring below it has
    // to give back. An account name is also the one string in the frame that
    // arrives from somebody else and can be arbitrarily long.
    { question: "Ready?", body: "Last look before anything is created.",
      status: "Cloudflare account: An Extremely Long Cloudflare Account Name, Ltd. (someone@example.com)",
      facts: [["Front end", "the bundled enrollment page"]], choices, cursor: 0 },
  ];
  let bad = 0;
  let checked = 0;
  for (let cols = 30; cols <= 200; cols += 7) {
    for (let lines = 10; lines <= 60; lines += 3) {
      for (const spec of specimens) {
        const rendered = rows(renderFrame({ step: 1, total: 2, canGoBack: true, ...spec, cols, lines }));
        checked += 1;
        if (rendered.length !== lines) bad += 1;
        else if (rendered.some((l) => [...l].length !== cols)) bad += 1;
      }
    }
  }
  ok(`every frame is exactly its terminal (${checked} sizes, ${bad} wrong)`, bad === 0);
}

// The review screen: no counter, and the answers as an aligned block.
const review = renderFrame({ step: null, total: null, question: "Ready?", body: "Last look.",
  facts: [["Front end", "the bundled enrollment page"], ["Enrollment", "open to anyone"]],
  choices: [{ label: "Yes, set it up", value: true }], cursor: 0, cols: 74, lines: 24 });
ok("the counter is dropped when there is no step to count", !plain(review).includes("question"));
ok("the review lists every answer",
  plain(review).includes("the bundled enrollment page") && plain(review).includes("open to anyone"));
const factColumn = (label) => rows(review).find((l) => l.includes(label)).indexOf(label);
ok("the review's labels line up", factColumn("Front end") === factColumn("Enrollment"));
