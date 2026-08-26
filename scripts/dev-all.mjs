/**
 * Runs the whole system in one terminal.
 *
 *   npm run dev:all
 *
 * Five processes: API, worker, customer PWA, kitchen board, platform console.
 * The old version of
 * this script was `npm run dev & npm run dev:pwa`, which started two of them,
 * detached the first from your Ctrl-C, and left a node process holding port
 * 3000 after you thought you had stopped it.
 *
 * WHY OUTPUT IS PREFIXED AND NOT SUPPRESSED
 *
 * Because in development the API log IS part of the product. The customer's
 * OTP is printed there (no SMS until DLT registration completes) and so is
 * every notification that would have been sent. A runner that hid the logs to
 * look tidy would make the app impossible to use.
 */

import { execFileSync, spawn } from 'node:child_process';
import process from 'node:process';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

/**
 * ============================================================================
 * PORTS ARE CHECKED BEFORE ANYTHING STARTS
 * ============================================================================
 *
 * WHY THIS IS WORTH FIFTY LINES
 *
 * An orphaned dev server produces the single most misleading failure in this
 * repo, and it is invisible unless you read five stack traces:
 *
 *   1. a previous run is killed in a way that leaves `vite` behind — a closed
 *      terminal tab, `kill -9`, a laptop that slept, a crash. The signal
 *      handler below cannot run in any of those cases.
 *   2. the orphan keeps serving 5173 from the code as it was THEN.
 *   3. `npm run dev:all` starts a new Vite, which dies instantly with
 *      EADDRINUSE — correctly, because `strictPort` is on.
 *   4. the browser is still talking to the ORPHAN and shows the old UI.
 *   5. you restart again. Step 3 repeats. Nothing you do has any effect,
 *      because the thing serving the page was never the thing you restarted.
 *
 * The symptom — "I restarted the server and it still shows the old UI" — points
 * at the browser, at caching, at the build, at anything except the true cause.
 * Whoever hits it loses an afternoon.
 *
 * `strictPort: true` in each Vite config is what makes this DETECTABLE rather
 * than silent (the default would move to 5176 and give you a second tab of the
 * same app). This check is what makes it legible.
 */
const PORTS = [
  { port: 3000, what: 'api' },
  { port: 5173, what: 'pwa' },
  { port: 5174, what: 'kds' },
  { port: 5175, what: 'admin' },
];

/** PIDs listening on a port. `[]` when nothing is, or when lsof is missing. */
function listenersOn(port) {
  try {
    // -sTCP:LISTEN so a browser's ESTABLISHED connection to the port is not
    // mistaken for a server holding it.
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean);
  } catch {
    // lsof exits non-zero when there are no matches, which is the common case.
    return [];
  }
}

function describe(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', pid], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .slice(0, 72);
  } catch {
    return '(gone)';
  }
}

function preflight() {
  const busy = PORTS.map((p) => ({ ...p, pids: listenersOn(p.port) })).filter(
    (p) => p.pids.length > 0,
  );

  if (busy.length === 0) return;

  /**
   * BOTH SPELLINGS WORK, because npm silently eats one of them.
   *
   *   npm run dev:all -- --clear-ports    the flag reaches process.argv
   *   npm run dev:all --clear-ports       npm keeps it as its OWN config and
   *                                       the script sees no arguments at all
   *
   * The second is what everybody types, and npm's only complaint is a warning
   * scrolled off the top of five processes' output. The script then refused,
   * printed "clear them and start: npm run dev:all -- --clear-ports", and the
   * person read that as the command they had just run.
   *
   * npm does at least turn unknown flags into `npm_config_*` environment
   * variables, so the swallowed form is recoverable. Accepting it is better
   * than being right about the separator.
   */
  const clear =
    process.argv.includes('--clear-ports') ||
    process.env['npm_config_clear_ports'] !== undefined;

  console.log(
    `\n${YELLOW}${BOLD}${busy.length} port${busy.length === 1 ? ' is' : 's are'} already in use.${RESET}\n`,
  );
  for (const b of busy) {
    console.log(`  ${RED}${b.port}${RESET}  ${b.what.padEnd(6)} pid ${b.pids.join(', ')}`);
    for (const pid of b.pids) console.log(`        ${DIM}${describe(pid)}${RESET}`);
  }

  if (!clear) {
    console.log(
      `\n  These are almost certainly orphans from an earlier run — a closed terminal,\n` +
        `  a kill -9, or a laptop that slept. ${BOLD}They are still serving the old code.${RESET}\n` +
        `  Starting now would leave them running and the new servers would die on the\n` +
        `  clash, so your browser would keep showing exactly what it shows today.\n\n` +
        // `dev:clean` and not `dev:all -- --clear-ports`. The flag form is one
        // missing separator away from npm swallowing it and this same message
        // printing again — which reads as the command not working.
        `  ${BOLD}Clear them and start:${RESET}\n` +
        `    npm run dev:clean\n\n` +
        `  ${BOLD}Or look first:${RESET}\n` +
        `    lsof -i tcp:3000 -i tcp:5173 -i tcp:5174 -i tcp:5175 -sTCP:LISTEN\n`,
    );
    process.exit(1);
  }

  console.log(`\n  ${DIM}--clear-ports: stopping them.${RESET}`);
  for (const b of busy) {
    for (const pid of b.pids) {
      try {
        // SIGTERM, never SIGKILL. These are dev servers, but SIGKILL is how the
        // orphan got created in the first place — a killed process runs no
        // cleanup, so its own children survive and hold the port again.
        process.kill(Number(pid), 'SIGTERM');
        console.log(`    ${GREEN}stopped${RESET} pid ${pid} on ${b.port}`);
      } catch (e) {
        console.log(`    ${RED}could not stop${RESET} pid ${pid}: ${e.message}`);
      }
    }
  }

  // A moment for the sockets to actually close, then verify rather than assume.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const stillBusy = busy.filter((b) => listenersOn(b.port).length > 0);
    if (stillBusy.length === 0) {
      console.log(`  ${GREEN}all clear.${RESET}`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }

  const stubborn = busy.filter((b) => listenersOn(b.port).length > 0);
  if (stubborn.length > 0) {
    console.log(
      `\n  ${RED}Still held: ${stubborn.map((b) => b.port).join(', ')}.${RESET}\n` +
        `  Something is ignoring SIGTERM. Find it with:\n` +
        `    lsof -i tcp:${stubborn[0].port} -sTCP:LISTEN\n`,
    );
    process.exit(1);
  }
}

/**
 * Colour by role, not by arbitrary rotation: the two you read most (API, for
 * OTP codes and notifications; worker, for the escalation ladder) are the
 * warm ones, and the two you mostly ignore are dim.
 */
const TARGETS = [
  { name: 'api   ', colour: '\x1b[36m', args: ['run', 'dev'] },
  { name: 'worker', colour: '\x1b[33m', args: ['run', 'dev:worker'] },
  { name: 'pwa   ', colour: '\x1b[35m', args: ['run', 'dev:pwa'] },
  { name: 'kds   ', colour: '\x1b[34m', args: ['run', 'dev:kds'] },
  { name: 'admin ', colour: '\x1b[32m', args: ['run', 'dev:admin'] },
];

const children = [];
let shuttingDown = false;

function start(target) {
  const target_name = target.name.trim();
  const child = spawn('npm', target.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so the signal handler below can kill the whole tree.
    // Without this, `tsx --watch` and `vite` leave orphans holding their ports
    // and the next `npm run dev:all` fails with EADDRINUSE.
    detached: true,
  });

  const prefix = `${target.colour}${target.name}${RESET} │ `;

  const pipe = (stream) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      // Keep the last partial line for the next chunk, so a prefix is never
      // inserted into the middle of a log line.
      buffer = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
    stream.on('end', () => {
      if (buffer) process.stdout.write(prefix + buffer + '\n');
    });
  };

  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(
      `${prefix}exited (${signal ?? code}). The others are still running; fix and restart.\n`,
    );

    /**
     * A front end that dies AFTER preflight passed means something grabbed the
     * port in between, and the consequence is the misleading one: the browser
     * keeps rendering whatever is on that port and every restart appears to do
     * nothing. Said explicitly rather than left in a Vite stack trace.
     */
    const target = PORTS.find((p) => p.what === target_name);
    if (target && listenersOn(target.port).length > 0) {
      process.stdout.write(
        `${prefix}${YELLOW}something else is on ${target.port} — the browser is talking to THAT, ` +
          `not to this.${RESET}\n${prefix}${DIM}npm run dev:all -- --clear-ports${RESET}\n`,
      );
    }
    // Deliberately does NOT tear everything down. One crashed Vite server
    // should not kill an API you are mid-way through debugging.
  });

  children.push({ child, name: target.name.trim() });
  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\nstopping (${signal})…\n`);

  for (const { child, name } of children) {
    try {
      // Negative pid = the whole process group. This is the part the old
      // `&`-based script could not do.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      process.stdout.write(`  ${name} was already gone\n`);
    }
  }

  // The API drains in-flight requests for up to 20s (INF-03) and the worker
  // finishes its tick. Give them a beat, then stop waiting.
  setTimeout(() => process.exit(0), 2500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// BEFORE the banner. Printing "starting five processes" and then failing three
// of them is how the port clash stayed invisible.
preflight();

console.log(`
  Starting five processes. Ctrl-C stops all of them.

    api      http://localhost:3000   health at /healthz, /readyz
    pwa      http://localhost:5173   the customer
    kds      http://localhost:5174   the kitchen
    admin    http://localhost:5175   the platform console

  Watch the api lines: OTP codes and "ready to collect" messages are printed
  there, because nothing is delivered until DLT registration completes.
`);

for (const t of TARGETS) start(t);
