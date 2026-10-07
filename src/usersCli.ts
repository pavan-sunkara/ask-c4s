/**
 * Break-glass user administration from the HOST — no HTTP, no token. Whoever can
 * run this already controls the server (and its .env), so it is the way back in
 * when the last owner has forgotten their password.
 *
 *   node dist/usersCli.js list
 *   node dist/usersCli.js set-owner <email> <temporary-password>
 *
 * set-owner creates the account, or promotes and re-enables an existing one, and
 * sets a temporary password the person must change at their next sign-in.
 *
 * In a container:  docker exec -it <container> node dist/usersCli.js list
 *
 * Note: this runs in its own process, so it can't drop tokens the running server
 * already issued. It doesn't need to — the server re-reads each account on every
 * request, and a temporary password forces a change before anything else works.
 */
import { UserError, directoryActive, listUsers, systemSetOwner } from "./users.js";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  node dist/usersCli.js list",
      "  node dist/usersCli.js set-owner <email> <temporary-password>",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "list") {
    if (!directoryActive()) {
      console.log("No personal accounts yet (the deployment is still on the shared password).");
      return;
    }
    for (const user of listUsers()) {
      const last = user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : "never";
      console.log(
        `${user.email.padEnd(40)} ${user.role.padEnd(8)} ${user.status.padEnd(9)} last sign-in: ${last}`,
      );
    }
    return;
  }

  if (command === "set-owner") {
    const [email, password] = args;
    if (!email || !password) usage();
    const user = await systemSetOwner(email, password);
    console.log(`${user.email} is now an active owner. They must change the password at next sign-in.`);
    return;
  }

  usage();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof UserError ? error.message : error);
    process.exit(1);
  });
