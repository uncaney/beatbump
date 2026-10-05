// c49b: first_pack_card (steps-c48-dayone.cjs) alone, C48_SKIP bypassed for it, the two other c48 steps skipped.
// run.sh <url> <query> probe-c49b-firstpack.cjs
require("./c46b-lib.cjs").main({ module: "./steps-c48-dayone.cjs", skipSet: "C48_SKIP", unskip: ["first_pack_card"], extraSkip: ["install_hint_after_sound", "account_form_keeps_input"] });
