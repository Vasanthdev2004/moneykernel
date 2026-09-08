// Placeholder for commands the PRD requires (section 22.2) that a later gate implements.
// Exits non-zero so a placeholder can never be mistaken for a passing command.
const [name = "command", gate = "a later gate"] = process.argv.slice(2);
console.error(`${name}: NOT_IMPLEMENTED (planned for ${gate}); see prd.md section 22.2`);
process.exitCode = 2;
