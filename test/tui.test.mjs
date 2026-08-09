// The full-screen questions, tested where they can be: the layout is a pure
// function from state to a string, and the key decoding is a pure function from a
// stdin chunk to a list of keys. Neither needs a terminal, which is the whole
// reason they are separated from the loop that owns one.
import { columns, keysOf, renderFrame, wrap } from "../scripts/tui.mjs";

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
// renderFrame.

const choices = [
  { label: "A workers.dev address", hint: "Free, and stable while the name holds.", value: "wd" },
  { label: "A domain on Cloudflare", hint: "The deploy provisions DNS.", value: "dom" },
];
const frame = (over = {}) =>
  renderFrame({ step: 2, total: 3, question: "Where will devices enrol?", body: "Pick one.",
    choices, cursor: 0, cols: 74, ...over });

const first = frame();
ok("the header counts the question", first.includes("question 2 of 3"));
ok("the cursor marks the current choice", first.includes("▸ A workers.dev address"));
ok("the other choice carries no marker", first.includes("  A domain on Cloudflare"));
ok("a choice question says how to choose", first.includes("↑ ↓ or 1-9 to choose"));

const second = frame({ cursor: 1 });
ok("moving the cursor moves the marker",
  second.includes("▸ A domain on Cloudflare") && !second.includes("▸ A workers.dev address"));

// A hint indented past its own label reads as belonging to the next one.
const labelColumn = first.split("\n").find((l) => l.includes("A workers.dev address")).indexOf("A workers");
const hintColumn = first.split("\n").find((l) => l.includes("Free, and stable")).indexOf("Free,");
ok("hints line up under their label, not under the marker", labelColumn === hintColumn);

const typed = renderFrame({ step: 2, total: 3, question: "Which hostname?", body: "No scheme.",
  value: "push.example.com", cols: 74 });
ok("a text question shows what has been typed", typed.includes("push.example.com█"));
ok("a text question offers no choice keys", !typed.includes("to choose"));
ok("a text question still says how to confirm", typed.includes("⏎ to confirm"));
ok("no choices are rendered when there are none", !typed.includes("▸"));

const complained = renderFrame({ step: 1, total: 3, question: "Which hostname?", body: "No scheme.",
  value: "https://x.example.com", error: "just the hostname, with no https:// in front.", cols: 74 });
ok("a complaint is shown with the value that caused it",
  complained.includes("just the hostname, with no https:// in front.") &&
  complained.includes("https://x.example.com█"));

// Every line has to fit, or the rules wrap and the frame comes apart.
for (const [label, rendered] of [["choices", first], ["text", complained]]) {
  const longest = Math.max(...rendered.split("\n").map((l) => [...l].length));
  ok(`the ${label} frame stays inside its width (${longest} <= 74)`, longest <= 74);
}

const narrow = renderFrame({ step: 1, total: 2, question: "Where will devices enrol?",
  body: "Moving it later means every device enrols again by hand.", choices, cursor: 0, cols: 40 });
const widest = Math.max(...narrow.split("\n").map((l) => [...l].length));
ok(`a 40-column terminal still fits (${widest} <= 40)`, widest <= 40);

ok("the counter is dropped when there is no step to count",
  !renderFrame({ step: null, total: null, question: "q", body: "b", value: "", cols: 74 })
    .includes("question"));
