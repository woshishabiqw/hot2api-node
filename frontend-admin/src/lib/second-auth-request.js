/**
 * Global second-auth request hook.
 *
 * SecondAuthDialogProvider mounts a real implementation; api.js imports the
 * live binding so it can trigger the PIN dialog without a circular dependency.
 */
export let requestSecondAuth = () => Promise.reject(new Error('SecondAuthDialogProvider not mounted'));

export function setRequestSecondAuth(fn) {
  requestSecondAuth = fn;
}
