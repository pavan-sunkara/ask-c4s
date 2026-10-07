/**
 * `Account` is the B2B-vocabulary alias of `Customer`.
 *
 * Use whichever name is natural in calling code. Both refer to the same
 * canonical record shape — there is no distinct entity behind this alias.
 */
export type { Customer as Account } from "./customer.js";
