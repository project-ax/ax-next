/**
 * What a saved signing secret does, shown next to the Signing secret row on the task page and in
 * Settings. A saved secret is the only switch (TASK-1027): settings saved before TASK-1026 are ignored.
 */
export function SigningSecretHelp() {
  return <p className="text-sm text-muted-foreground">Paste the signing secret from the other app’s webhook settings. Once it’s saved, we recognize the app and turn away updates whose signature doesn’t match. Without a secret, updates aren’t checked.</p>;
}
